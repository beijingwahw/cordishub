/**
 * 多租户安全网（Safety Net）
 *
 * 灵感来自 deepseek.international 2026-05 的多租户实战分享。
 * 三类污染 + 一道闸门：
 *   1. 缓存污染：tenant A 的 cache 被 tenant B 命中
 *   2. 工具越权：agent 看到本租户不该有的 tool
 *   3. 记忆污染：memory 2.0 写入无关细节
 *
 * Safety Net 的核心：每个 session 显式打 `tenant` + `toolWhitelist` tag，
 * 所有 cache / embedding / scratchpad 都强制 namespaced。
 */

import type { SessionEvent } from './types.ts';
import { assertTool, type Capability } from './capability.ts';

export interface SafetyPolicy {
  tenant: string;
  /** 允许的工具白名单 */
  toolWhitelist?: string[];
  /** v0.4 · 能力令牌（ocap）：设置后工具准入走结构性 assertTool，优先于 toolWhitelist */
  capability?: Capability;
  /** 允许的子 agent ID 白名单 */
  subagentWhitelist?: string[];
  /** 配额：单 session 最大 token */
  maxTokens?: number;
  /** 配额：单 session 最大成本 USD */
  maxCostUsd?: number;
  /** 配额：单 session 最大子 agent 调度数 */
  maxSubagents?: number;
  /** 是否启用 memory gate（写入前打分） */
  memoryGate?: boolean;
  /** memory gate 阈值（0-1，越高越严格） */
  memoryGateThreshold?: number;
}

export interface SafetyViolation {
  kind: 'tool-overreach' | 'token-cap' | 'budget-cap' | 'subagent-cap' | 'cache-collision';
  detail: string;
  ts: number;
  severity: 'warn' | 'block';
}

export interface SafetyCheckResult {
  ok: boolean;
  violations: SafetyViolation[];
}

/** 记忆 gate：把候选写入打分（0-1），低于阈值拒绝 */
export interface MemoryGateScorer {
  score(content: string, options?: { tenant?: string }): Promise<{
    score: number;
    reason: string;
  }>;
}

export class SafetyNet {
  private violations: SafetyViolation[] = [];

  private policy: SafetyPolicy;
  constructor(policy: SafetyPolicy) {
    this.policy = policy;
    this.validatePolicy();
  }

  private validatePolicy(): void {
    if (!this.policy.tenant) {
      throw new Error('SafetyPolicy.tenant is required');
    }
  }

  /** 检查一个 event 是否合规 */
  check(event: SessionEvent, accum?: { tokens: number; cost: number; subagents: number }): SafetyCheckResult {
    const violations: SafetyViolation[] = [];

    // 工具越权
    if (event.source === 'tool') {
      const toolName = (event.payload as any).tool_name as string;
      if (this.policy.capability) {
        // ocap 模式：结构性准入（过期 / 未授予都会被拒）
        try {
          if (toolName) assertTool(this.policy.capability, toolName, event.ts);
        } catch (err) {
          violations.push({
            kind: 'tool-overreach',
            detail: (err as Error).message,
            ts: event.ts,
            severity: 'block',
          });
        }
      } else if (this.policy.toolWhitelist && toolName && !this.policy.toolWhitelist.includes(toolName)) {
        violations.push({
          kind: 'tool-overreach',
          detail: `tool "${toolName}" not in whitelist for tenant "${this.policy.tenant}"`,
          ts: event.ts,
          severity: 'block',
        });
      }
    }

    // 子 agent 越权
    if (event.source === 'subagent' && this.policy.subagentWhitelist && event.subagentId) {
      if (!this.policy.subagentWhitelist.includes(event.subagentId)) {
        violations.push({
          kind: 'subagent-cap',
          detail: `subagent "${event.subagentId}" not in whitelist`,
          ts: event.ts,
          severity: 'block',
        });
      }
    }

    // 配额
    if (accum) {
      if (this.policy.maxTokens && accum.tokens > this.policy.maxTokens) {
        violations.push({
          kind: 'token-cap',
          detail: `session exceeded maxTokens (${accum.tokens} > ${this.policy.maxTokens})`,
          ts: event.ts,
          severity: 'block',
        });
      }
      if (this.policy.maxCostUsd && accum.cost > this.policy.maxCostUsd) {
        violations.push({
          kind: 'budget-cap',
          detail: `session exceeded maxCost ($${accum.cost.toFixed(4)} > $${this.policy.maxCostUsd})`,
          ts: event.ts,
          severity: 'block',
        });
      }
      if (this.policy.maxSubagents && accum.subagents > this.policy.maxSubagents) {
        violations.push({
          kind: 'subagent-cap',
          detail: `session exceeded maxSubagents (${accum.subagents} > ${this.policy.maxSubagents})`,
          ts: event.ts,
          severity: 'block',
        });
      }
    }

    if (violations.length > 0) this.violations.push(...violations);
    return { ok: violations.length === 0, violations };
  }

  /** 给缓存 / embedding 打 tenant tag */
  namespaceKey(key: string): string {
    return `t:${this.policy.tenant}::${key}`;
  }

  /** memory gate 评分 */
  async gateMemory(content: string, scorer: MemoryGateScorer): Promise<{
    accepted: boolean;
    score: number;
    reason: string;
  }> {
    if (!this.policy.memoryGate) return { accepted: true, score: 1, reason: 'gate disabled' };
    const result = await scorer.score(content, { tenant: this.policy.tenant });
    const threshold = this.policy.memoryGateThreshold ?? 0.5;
    return { accepted: result.score >= threshold, ...result };
  }

  /** 历史 violations */
  history(): SafetyViolation[] {
    return [...this.violations];
  }

  /** 记录一条 service 层直接产生的违规（如预算预授权拒绝） */
  record(violation: SafetyViolation): void {
    this.violations.push(violation);
  }

  /** 从持久化存储恢复历史违规（service 启动时调用，使 dashboard / CLI 重启后仍可见） */
  restore(violations: SafetyViolation[]): void {
    for (const v of violations) this.record(v);
  }
}