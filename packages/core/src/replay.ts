/**
 * 会话回放引擎
 *
 * 三大能力：
 *   1. time-travel：从任意一个 checkpoint 拉出当时的状态
 *   2. diff：对比两个 session 在同一 seq 的差异
 *   3. fork：从任意 event 拉出一个新的分支 session
 *
 * 设计哲学：DSH 的 session log 是 append-only 的 event stream，
 * 回放就是把 stream 重新播放到指定位置 —— 类似 git checkout + git log。
 */

import type { Session, SessionEvent } from './types.ts';
import type { Storage } from './storage.ts';

export interface ReplayState {
  sessionId: string;
  /** 当前回放到的 seq */
  seq: number;
  /** 该 seq 之前所有 events */
  history: SessionEvent[];
  /** 系统提示（拼接所有 system 事件） */
  systemPrompt: string;
  /** 拼接的用户输入 */
  userInputs: string[];
  /** 所有 tool call */
  toolCalls: Array<{
    id: string;
    name: string;
    args: unknown;
    result?: unknown;
  }>;
  /** reasoning 累计 */
  reasoning: string[];
  /** token 累计 */
  totalTokens: number;
  /** 累计成本 */
  totalCost: number;
}

export interface DiffOptions {
  /** 要对比的 seq 区间 */
  fromSeq: number;
  toSeq: number;
}

export interface DiffResult {
  /** 仅在 sessionA 出现 */
  onlyInA: SessionEvent[];
  /** 仅在 sessionB 出现 */
  onlyInB: SessionEvent[];
  /** 两边都有但 payload 不同 */
  different: Array<{ a: SessionEvent; b: SessionEvent; changedKeys: string[] }>;
}

export class ReplayEngine {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** 把 events 重新播放成一个 ReplayState */
  reconstruct(sessionId: string, upToSeq?: number): ReplayState {
    const events =
      upToSeq === undefined
        ? this.storage.getEvents(sessionId)
        : this.storage.getEventRange(sessionId, 0, upToSeq);

    const state: ReplayState = {
      sessionId,
      seq: 0,
      history: [],
      systemPrompt: '',
      userInputs: [],
      toolCalls: [],
      reasoning: [],
      totalTokens: 0,
      totalCost: 0,
    };

    for (const ev of events) {
      state.seq = ev.seq;
      state.history.push(ev);

      switch (ev.source) {
        case 'system': {
          const txt = (ev.payload as any).text ?? '';
          state.systemPrompt += txt + '\n';
          break;
        }
        case 'user': {
          const txt = (ev.payload as any).text ?? '';
          state.userInputs.push(txt);
          break;
        }
        case 'reasoning': {
          const txt = (ev.payload as any).text ?? '';
          state.reasoning.push(txt);
          break;
        }
        case 'tool': {
          const toolName = (ev.payload as any).tool_name ?? 'unknown';
          const toolArgs = (ev.payload as any).arguments;
          const toolResult = (ev.payload as any).result;

          // 配对一个 call + result
          if (ev.toolCallId) {
            const existing = state.toolCalls.find((t) => t.id === ev.toolCallId);
            if (existing) {
              if (existing.result === undefined) existing.result = toolResult;
            } else {
              state.toolCalls.push({
                id: ev.toolCallId,
                name: toolName,
                args: toolArgs,
                result: toolResult,
              });
            }
          } else {
            state.toolCalls.push({
              id: ev.id,
              name: toolName,
              args: toolArgs,
              result: toolResult,
            });
          }
          break;
        }
        case 'subagent': {
          // 子 agent 调度的实际 token / cost 会计入
          break;
        }
      }

      if (ev.tokens) {
        state.totalTokens += ev.tokens.total;
      }
    }

    return state;
  }

  /** 对比两个 session 在 [fromSeq, toSeq] 区间的差异 */
  diff(sessionA: string, sessionB: string, opts: DiffOptions): DiffResult {
    const a = this.storage.getEventRange(sessionA, opts.fromSeq, opts.toSeq);
    const b = this.storage.getEventRange(sessionB, opts.fromSeq, opts.toSeq);

    const bySeqA = new Map(a.map((e) => [e.seq, e]));
    const bySeqB = new Map(b.map((e) => [e.seq, e]));

    const onlyInA: SessionEvent[] = [];
    const onlyInB: SessionEvent[] = [];
    const different: DiffResult['diff'] = [];

    const allSeqs = new Set([...bySeqA.keys(), ...bySeqB.keys()]);
    for (const seq of allSeqs) {
      const ea = bySeqA.get(seq);
      const eb = bySeqB.get(seq);
      if (ea && !eb) onlyInA.push(ea);
      else if (eb && !ea) onlyInB.push(eb);
      else if (ea && eb) {
        const changedKeys = this.payloadDiffKeys(ea.payload, eb.payload);
        if (changedKeys.length > 0) {
          different.push({ a: ea, b: eb, changedKeys });
        }
      }
    }

    return { onlyInA, onlyInB, different };
  }

  /** Fork：从 sessionA 的 fromSeq 开始拉出一个新 sessionB */
  fork(
    sessionA: string,
    fromSeq: number,
    newSessionId: string,
    options?: { model?: string; label?: string },
  ): Session {
    const events = this.storage.getEventRange(sessionA, 0, fromSeq);
    const last = events[events.length - 1];
    if (!last) {
      throw new Error(`Cannot fork: session ${sessionA} has no events up to seq ${fromSeq}`);
    }

    const forked: Session = {
      id: newSessionId,
      startedAt: Date.now(),
      model: options?.model ?? last.model ?? 'unknown',
      totalTokens: 0,
      totalCost: 0,
      meta: { forkedFrom: { sessionId: sessionA, seq: fromSeq }, label: options?.label },
    };
    this.storage.beginSession(forked);

    // 重写 events 到新 session，保持相同的 seq
    let totalTokens = 0;
    for (const ev of events) {
      if (ev.tokens) totalTokens += ev.tokens.total;
      const newEvent: SessionEvent = {
        ...ev,
        id: `${newSessionId}-${ev.seq}`,
        sessionId: newSessionId,
      };
      this.storage.appendEvent(newEvent);
    }

    forked.totalTokens = totalTokens;
    return forked;
  }

  /** 全局搜索 session 中的内容 */
  search(query: string, limit = 50) {
    return this.storage.fullTextSearch(query, limit);
  }

  private payloadDiffKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const diff: string[] = [];
    for (const k of keys) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diff.push(k);
    }
    return diff;
  }
}