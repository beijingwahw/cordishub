/**
 * Cassette 确定性回放盒（L1）—— 把 Replay Lab 从"查看器"升级为"实验台"。
 *
 * 诚实的能力边界：CordisHub 是外挂工作台，控制不了模型本体，无法承诺
 * bit 级确定性。承诺的是**上下文确定性**：重放中工具响应全部来自盒带
 * （VCR 式），时间/输入固定，模型以可注入的纯函数接入——换模型 = 换函数。
 * 未录到采样参数（determinism.samplingRecorded = false）时，本模块退化为
 * 结构化查看器；录到了才有反事实重放的完整语义。
 *
 * 三种实验：
 *   1. verifyTape        —— 盒带自检（配对完整性）
 *   2. playCounterfactual —— 注入模型 + 可选故障（fault-inject）重放，报告分叉点
 *   3. bisectFirstBad    —— 因果二分：O(log n) 重构找到"最早坏状态"的 seq
 */
import type { Storage } from './storage.ts';
import type { ReplayEngine, ReplayState } from './replay.ts';
import { foldEvent } from './replay.ts';

export type CassetteEntry =
  | { kind: 'model'; seq: number; ts: number; model: string; text: string; sampling?: Record<string, unknown> }
  | { kind: 'tool-call'; seq: number; ts: number; toolCallId?: string; tool: string; args: unknown }
  | { kind: 'tool-result'; seq: number; ts: number; toolCallId?: string; tool: string; result: unknown }
  | { kind: 'context'; seq: number; ts: number; source: 'system' | 'user' | 'reasoning' | 'context' | 'subagent' | 'meta'; text: string };

export interface CassetteTape {
  sessionId: string;
  recordedAt: number;
  entries: CassetteEntry[];
  determinism: {
    toolsRecorded: boolean;
    samplingRecorded: boolean;
    timeRecorded: boolean;
  };
}

/** 从事件流录制盒带（日志 → 可重放的"非确定性输入"清单） */
export function recordTape(sessionId: string, storage: Storage, _replay: ReplayEngine): CassetteTape | undefined {
  if (!storage.getSession(sessionId)) return undefined;
  const entries: CassetteEntry[] = [];
  let toolsRecorded = false;
  let samplingRecorded = false;

  for (const ev of storage.getEvents(sessionId)) {
    const p = ev.payload as Record<string, unknown>;
    if (ev.source === 'model') {
      const sampling = (p['sampling'] ?? p['params']) as Record<string, unknown> | undefined;
      if (sampling) samplingRecorded = true;
      entries.push({
        kind: 'model',
        seq: ev.seq,
        ts: ev.ts,
        model: ev.model ?? '',
        text: typeof p['text'] === 'string' ? p['text'] : '',
        sampling,
      });
    } else if (ev.source === 'tool') {
      const args = p['arguments'] ?? p['args'];
      const result = p['result'] ?? (p['stdout'] !== undefined ? { stdout: p['stdout'] } : undefined);
      const tool = typeof p['tool_name'] === 'string' ? p['tool_name'] : 'unknown';
      if (args !== undefined) {
        entries.push({ kind: 'tool-call', seq: ev.seq, ts: ev.ts, toolCallId: ev.toolCallId, tool, args });
      }
      if (result !== undefined) {
        toolsRecorded = true;
        entries.push({ kind: 'tool-result', seq: ev.seq, ts: ev.ts, toolCallId: ev.toolCallId, tool, result });
      }
    } else {
      entries.push({
        kind: 'context',
        seq: ev.seq,
        ts: ev.ts,
        source: ev.source,
        text: typeof p['text'] === 'string' ? p['text'] : '',
      });
    }
  }

  return {
    sessionId,
    recordedAt: Date.now(),
    entries,
    determinism: { toolsRecorded, samplingRecorded, timeRecorded: true },
  };
}

export interface TapeReport {
  ok: boolean;
  entries: number;
  toolCalls: number;
  toolResults: number;
  orphanResults: number;
  unmatchedCalls: number;
}

/** 盒带自检：call 与 result 的配对完整性（LIFO 相邻配对） */
export function verifyTape(tape: CassetteTape): TapeReport {
  let toolCalls = 0;
  let toolResults = 0;
  let orphanResults = 0;
  const open: number[] = [];
  for (const e of tape.entries) {
    if (e.kind === 'tool-call') {
      toolCalls++;
      open.push(e.seq);
    } else if (e.kind === 'tool-result') {
      toolResults++;
      if (open.pop() === undefined) orphanResults++;
    }
  }
  return {
    ok: orphanResults === 0 && open.length === 0,
    entries: tape.entries.length,
    toolCalls,
    toolResults,
    orphanResults,
    unmatchedCalls: open.length,
  };
}

// ---------------------------------------------------------------------------
// 反事实重放
// ---------------------------------------------------------------------------

export type CfAction = { type: 'tool'; tool: string; args?: unknown } | { type: 'say'; text: string } | { type: 'stop' };

/** 注入的模型：纯函数（状态, 步数) → 下一步动作。确定性由调用方保证 */
export interface CounterfactualModel {
  next(state: CfState, step: number): CfAction;
}

export interface CfState {
  systemPrompt: string;
  userInputs: string[];
  reasoning: string[];
  modelTexts: string[];
  toolCalls: Array<{
    tool: string;
    args: unknown;
    result?: unknown;
    injected?: boolean;
    error?: string;
    matchedRecorded?: boolean;
  }>;
}

export interface FaultSpec {
  /** 对第 N 个工具调用（0-based，本次重放内计数）注入故障 */
  atToolIndex: number;
  /** 篡改录制的响应（fault-inject） */
  mutate?: (recorded: unknown, tool: string) => unknown;
  /** 或直接注入工具错误 */
  error?: string;
}

export interface CfStep {
  step: number;
  action: CfAction;
  toolResult?: unknown;
  injected?: boolean;
  error?: string;
  matchedRecordedTool?: boolean;
}

export interface CounterfactualResult {
  sessionId: string;
  steps: CfStep[];
  endState: CfState;
  /** 与录制轨迹的第一个分叉步（null = 忠实重放） */
  divergedAtStep: number | null;
  stopReason: 'model-stop' | 'tape-exhausted' | 'max-steps';
}

function sameAction(a: CfAction, b: CfAction | undefined): boolean {
  if (!b) return false;
  if (a.type === 'tool' && b.type === 'tool') {
    return a.tool === b.tool && JSON.stringify(a.args ?? null) === JSON.stringify(b.args ?? null);
  }
  if (a.type === 'say' && b.type === 'say') return a.text === b.text;
  return false;
}

/**
 * 反事实重放：从 fromSeq 起，用注入的模型重跑；工具响应优先从盒带取
 * （上下文确定性），fault 可在第 N 个工具响应上注入篡改或错误。
 */
export function playCounterfactual(
  tape: CassetteTape,
  opts: { model: CounterfactualModel; fault?: FaultSpec; fromSeq?: number; maxSteps?: number },
): CounterfactualResult {
  const fromSeq = opts.fromSeq ?? 0;
  const maxSteps = opts.maxSteps ?? 100;

  // 前缀（seq < fromSeq）作为固定上下文
  const state: CfState = { systemPrompt: '', userInputs: [], reasoning: [], modelTexts: [], toolCalls: [] };
  const lastOpenCall = () => {
    for (let i = state.toolCalls.length - 1; i >= 0; i--) {
      if (state.toolCalls[i]!.result === undefined && state.toolCalls[i]!.error === undefined) return state.toolCalls[i];
    }
    return undefined;
  };
  for (const e of tape.entries) {
    if (e.seq >= fromSeq) break;
    if (e.kind === 'context') {
      if (e.source === 'system') state.systemPrompt += `${e.text}\n`;
      else if (e.source === 'user') state.userInputs.push(e.text);
      else if (e.source === 'reasoning') state.reasoning.push(e.text);
    } else if (e.kind === 'model') {
      state.modelTexts.push(e.text);
    } else if (e.kind === 'tool-call') {
      state.toolCalls.push({ tool: e.tool, args: e.args, matchedRecorded: true });
    } else if (e.kind === 'tool-result') {
      const open = lastOpenCall();
      if (open) open.result = e.result;
      else state.toolCalls.push({ tool: e.tool, args: undefined, result: e.result, matchedRecorded: true });
    }
  }

  // 录制侧的动作序列与工具响应（fromSeq 之后）
  const recordedActions: CfAction[] = [];
  const recordedToolResults: unknown[] = [];
  for (const e of tape.entries) {
    if (e.seq < fromSeq) continue;
    if (e.kind === 'tool-call') recordedActions.push({ type: 'tool', tool: e.tool, args: e.args });
    else if (e.kind === 'model') recordedActions.push({ type: 'say', text: e.text });
    else if (e.kind === 'tool-result') recordedToolResults.push(e.result);
  }

  const steps: CfStep[] = [];
  let divergedAtStep: number | null = null;
  let toolCounter = 0;
  let stopReason: CounterfactualResult['stopReason'] = 'model-stop';
  let exhausted = false;

  for (let step = 0; step < maxSteps; step++) {
    const action = opts.model.next(state, step);

    if (action.type === 'stop') {
      // 录制还在继续而重放停了 = 分叉
      if (divergedAtStep === null && sameAction(action, recordedActions[step]) === false && recordedActions[step] !== undefined) {
        divergedAtStep = step;
      }
      break;
    }

    if (divergedAtStep === null && !sameAction(action, recordedActions[step])) {
      divergedAtStep = step;
    }

    if (action.type === 'say') {
      state.modelTexts.push(action.text);
      steps.push({ step, action });
      continue;
    }

    // 工具调用：响应从盒带取，fault 命中则注入
    const idx = toolCounter++;
    let result: unknown;
    let injected = false;
    let error: string | undefined;
    let matched = true;
    const recorded = recordedToolResults[idx];
    if (opts.fault && opts.fault.atToolIndex === idx) {
      injected = true;
      if (opts.fault.error !== undefined) {
        error = opts.fault.error;
      } else {
        result = opts.fault.mutate ? opts.fault.mutate(recorded, action.tool) : recorded;
      }
    } else if (recorded === undefined) {
      matched = false;
      exhausted = true;
    } else {
      result = recorded;
    }

    state.toolCalls.push({ tool: action.tool, args: action.args, result, injected, error, matchedRecorded: matched });
    steps.push({ step, action, toolResult: result, injected, error, matchedRecordedTool: matched });
    if (exhausted) {
      stopReason = 'tape-exhausted';
      break;
    }
  }

  if (stopReason === 'model-stop' && !exhausted && steps.length >= maxSteps) stopReason = 'max-steps';

  return { sessionId: tape.sessionId, steps, endState: state, divergedAtStep, stopReason };
}

// ---------------------------------------------------------------------------
// 因果二分
// ---------------------------------------------------------------------------

export interface BisectResult {
  found: boolean;
  /** 最早使谓词为真的 seq（"从这一步开始走偏"） */
  seq: number | null;
  /** 重构次数（O(log n)） */
  checked: number;
}

/**
 * 因果二分：对"状态谓词"二分查找最早的坏 seq。
 * 前提：谓词单调（一旦变坏保持坏）——对"泄漏已发生/错误已引入"类状态天然成立；
 * 非单调谓词请用 locateBadEvents（单遍精确，见下）。
 */
export function bisectFirstBad(
  sessionId: string,
  storage: Storage,
  replay: ReplayEngine,
  isBad: (state: ReplayState) => boolean,
): BisectResult {
  const seqs = storage.getEvents(sessionId).map((e) => e.seq);
  if (seqs.length === 0) return { found: false, seq: null, checked: 0 };

  let lo = 0;
  let hi = seqs.length - 1;
  let found = -1;
  let checked = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const state = replay.reconstruct(sessionId, seqs[mid]!);
    checked++;
    if (isBad(state)) {
      found = seqs[mid]!;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return { found: found >= 0, seq: found >= 0 ? found : null, checked };
}

// ---------------------------------------------------------------------------
// 单遍区间扫描（非单调谓词的精确解）
// ---------------------------------------------------------------------------

export interface BadInterval {
  fromSeq: number;
  toSeq: number;
}

export interface ScanReport {
  /** 全部"坏区间"（谓词为真的连续 seq 段；非单调谓词可能有多个） */
  intervals: BadInterval[];
  firstBadSeq: number | null;
  eventsFolded: number;
}

/**
 * 单遍增量折叠定位全部坏区间：O(n) 次折叠（增量维护状态，而非每前缀全量
 * 重构的 O(n²)）。对非单调谓词精确——"错误反复出现/消失"的振荡场景也能
 * 给出完整区间图，而不是二分的单点近似。
 */
export function locateBadEvents(
  sessionId: string,
  storage: Storage,
  isBad: (state: ReplayState) => boolean,
): ScanReport {
  const events = storage.getEvents(sessionId);
  const state: ReplayState = {
    sessionId,
    seq: 0,
    history: [],
    systemPrompt: '',
    userInputs: [],
    modelResponses: [],
    toolCalls: [],
    reasoning: [],
    totalTokens: 0,
    totalCost: 0,
  };
  const intervals: BadInterval[] = [];
  let firstBadSeq: number | null = null;
  let inBad = false;

  for (const ev of events) {
    foldEvent(state, ev);
    if (isBad(state)) {
      if (firstBadSeq === null) firstBadSeq = ev.seq;
      if (!inBad) {
        intervals.push({ fromSeq: ev.seq, toSeq: ev.seq });
        inBad = true;
      } else {
        intervals[intervals.length - 1]!.toSeq = ev.seq;
      }
    } else {
      inBad = false;
    }
  }
  return { intervals, firstBadSeq, eventsFolded: events.length };
}

// ---------------------------------------------------------------------------
// 确定性证书（从"档位声明"升级为可执行证明）
// ---------------------------------------------------------------------------

export interface DeterminismCertificate {
  /** empty = 无模型轮次；context = 工具/时间固定、模型可注入；full = 采样参数已录 */
  level: 'empty' | 'context' | 'full';
  toolsRecorded: boolean;
  samplingRecorded: boolean;
  /**
   * 可执行稳定性证明：同盒带 + 同注入模型重放 N 次，轨迹是否逐位一致。
   * null = 未执行（未提供 model）。这把"我的实验可复现"从口头承诺变成检查过的断言。
   */
  replayStable: boolean | null;
  runsCompared: number;
  divergedAtStep: number | null;
}

/** 为盒带的全部模型轮次补盖采样参数（harness 已知自身参数时用；升到 full 档） */
export function stampSampling(tape: CassetteTape, sampling: Record<string, unknown>): CassetteTape {
  let stamped = false;
  for (const e of tape.entries) {
    if (e.kind === 'model') {
      e.sampling = { ...sampling };
      stamped = true;
    }
  }
  if (stamped) tape.determinism.samplingRecorded = true;
  return tape;
}

/** 颁发确定性证书：档位分级 + （可选）重放稳定性证明 */
export function certifyDeterminism(
  tape: CassetteTape,
  opts: { model?: CounterfactualModel; stabilityRuns?: number } = {},
): DeterminismCertificate {
  const hasModel = tape.entries.some((e) => e.kind === 'model');
  const level: DeterminismCertificate['level'] = !hasModel
    ? 'empty'
    : tape.determinism.samplingRecorded
      ? 'full'
      : 'context';

  let replayStable: boolean | null = null;
  let runsCompared = 0;
  let divergedAtStep: number | null = null;
  const n = opts.stabilityRuns ?? 0;
  if (opts.model && n > 1) {
    const signature = (r: CounterfactualResult) => JSON.stringify(r.steps) + '|' + JSON.stringify(r.endState.toolCalls);
    const first = playCounterfactual(tape, { model: opts.model });
    divergedAtStep = first.divergedAtStep;
    const expected = signature(first);
    replayStable = true;
    runsCompared = 1;
    for (let i = 1; i < n; i++) {
      const run = playCounterfactual(tape, { model: opts.model });
      runsCompared++;
      if (signature(run) !== expected) {
        replayStable = false;
        break;
      }
    }
  }
  return {
    level,
    toolsRecorded: tape.determinism.toolsRecorded,
    samplingRecorded: tape.determinism.samplingRecorded,
    replayStable,
    runsCompared,
    divergedAtStep,
  };
}
