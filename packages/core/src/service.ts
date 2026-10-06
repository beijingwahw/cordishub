/**
 * CordisHubService — 在 DSH 的 Cordis 上下文中注册
 *
 * 这是 DSH 插件的标准写法：
 *   1. extend 一个 Service（这里不强制 extend，因为 cordis 包不是必需的）
 *   2. 在 apply() 里调用 ctx.plugin(SomeService)
 *   3. 通过 ctx.on('event', ...) 监听 DSH 事件
 *
 * CordisHub 同时暴露以下服务，可单独 disable：
 *   - cordishub.replay   会话回放
 *   - cordishub.cost     成本计算
 *   - cordishub.hub      插件市场
 *   - cordishub.safety   多租户安全网
 */

import { Storage } from './storage.ts';
import { CostEngine, type CostOutput, type ModelRate } from './cost.ts';
import { ReplayEngine, type ReplayState, type DiffResult, type DiffOptions } from './replay.ts';
import { HubIndex, type PluginMeta, type SearchOptions, DEMO_PLUGINS } from './hub.ts';
import { SafetyNet, type SafetyPolicy, type SafetyCheckResult, type SafetyViolation } from './safety.ts';
import type { Session as SessionT, SessionEvent } from './types.ts';

export interface CordishubOptions {
  /** SQLite 文件路径 */
  dbPath?: string;
  /** 自定义费率表 */
  rates?: ModelRate[];
  /** 启用哪些能力（默认全开） */
  capabilities?: CapabilityFlag;
  /** 单租户安全策略 */
  safetyPolicy?: Partial<SafetyPolicy>;
  /** 是否吞掉 SafetyNet 抛出的违规（默认 true：warn + 记录，false：抛错） */
  onViolation?: 'warn' | 'log' | 'throw';
  /** DSH 事件名（不同版本可能略不同，可自定义） */
  events?: DshEventMap;
}

export interface CapabilityFlag {
  hub?: boolean;
  replay?: boolean;
  cost?: boolean;
  safety?: boolean;
}

/**
 * DSH 事件名映射 —— DSH 不同版本事件名可能略有差异。
 * 这层抽象让我们可以独立于 DSH 版本演进。
 */
export interface DshEventMap {
  /** session 开始 */
  sessionStart: string;
  /** session 结束 */
  sessionEnd: string;
  /** 模型响应（含 token 统计） */
  modelResponse: string;
  /** tool 调用 */
  toolCall: string;
  /** tool 结果 */
  toolResult: string;
  /** 子 agent 调度 */
  subagentScheduled: string;
  /** 上下文注入 */
  contextInjection: string;
}

const DEFAULT_EVENT_MAP: DshEventMap = {
  sessionStart: 'session/started',
  sessionEnd: 'session/ended',
  modelResponse: 'model/response',
  toolCall: 'tool/called',
  toolResult: 'tool/result',
  subagentScheduled: 'subagent/scheduled',
  contextInjection: 'context/injection',
};

interface CordisContextLike {
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
  plugin(target: any): void;
  emit(event: string, ...args: any[]): void;
  [k: string]: any;
}

/**
 * 主服务：对外暴露四个子服务
 */
export class CordishubService {
  static inject = [] as const;

  readonly storage: Storage;
  readonly costEngine: CostEngine;
  readonly replay: ReplayEngine;
  readonly hub: HubIndex;
  safety: SafetyNet;

  capabilities: CapabilityFlag;
  private ctx: CordisContextLike;
  private eventMap: DshEventMap;
  private onViolation: 'warn' | 'log' | 'throw';
  private sessionAccums = new Map<string, { tokens: number; cost: number; subagents: number }>();

  constructor(ctx: CordisContextLike, opts: CordishubOptions = {}) {
    this.ctx = ctx;
    this.storage = new Storage({
      path: opts.dbPath ?? './cordish.db',
      silent: false,
    });
    this.costEngine = new CostEngine(opts.rates);
    this.replay = new ReplayEngine(this.storage);
    this.hub = new HubIndex(this.storage);
    this.capabilities = {
      hub: true,
      replay: true,
      cost: true,
      safety: true,
      ...opts.capabilities,
    };
    this.eventMap = { ...DEFAULT_EVENT_MAP, ...opts.events };
    this.onViolation = opts.onViolation ?? 'warn';
    this.safety = new SafetyNet({
      tenant: 'default',
      // 默认安全策略：保守
      memoryGate: true,
      memoryGateThreshold: 0.6,
      maxCostUsd: 5.0,
      ...opts.safetyPolicy,
    });
  }

  /** 安装到 DSH 上下文 */
  install(): void {
    if (this.capabilities.replay || this.capabilities.cost || this.capabilities.safety) {
      this.ctx.plugin(this);
    }

    // Hub：内置 demo 数据（真实场景从 GitHub GraphQL 拉取）
    if (this.capabilities.hub) {
      this.hub.ingest(DEMO_PLUGINS);
      this.hub.load();
    }

    if (this.capabilities.replay || this.capabilities.cost || this.capabilities.safety) {
      this.attachListeners();
    }
  }

  private attachListeners(): void {
    // session 开始
    this.ctx.on(this.eventMap.sessionStart, (sess: SessionT) => {
      this.storage.beginSession(sess);
      this.sessionAccums.set(sess.id, { tokens: 0, cost: 0, subagents: 0 });
    });

    // session 结束
    this.ctx.on(this.eventMap.sessionEnd, (sessId: string, endedAt: number) => {
      this.storage.endSession(sessId, endedAt);
      this.sessionAccums.delete(sessId);
    });

    // 模型响应
    this.ctx.on(this.eventMap.modelResponse, (ev: SessionEvent) => {
      if (ev.tokens) {
        const cost = this.costEngine.compute({
          model: ev.model ?? 'unknown',
          promptTokens: ev.tokens.prompt,
          completionTokens: ev.tokens.completion,
          reasoningTokens: ev.tokens.reasoning,
          cacheReadTokens: ev.tokens.cacheRead,
          cacheWriteTokens: ev.tokens.cacheWrite,
          ts: ev.ts,
        });
        this.storage.accumulate(ev.sessionId, ev.tokens.total, cost.total);
        this.storage.appendEvent(ev);
        const a = this.sessionAccums.get(ev.sessionId);
        if (a) {
          a.tokens += ev.tokens.total;
          a.cost += cost.total;
        }
      } else {
        this.storage.appendEvent(ev);
      }

      if (this.capabilities.safety) {
        const a = this.sessionAccums.get(ev.sessionId);
        const r = this.safety.check(ev, a);
        if (!r.ok) this.handleViolations(r.violations);
      }
    });

    // tool call / result 都记到 storage
    this.ctx.on(this.eventMap.toolCall, (ev: SessionEvent) => {
      this.storage.appendEvent(ev);
      if (this.capabilities.safety) {
        const r = this.safety.check(ev);
        if (!r.ok) this.handleViolations(r.violations);
      }
    });

    this.ctx.on(this.eventMap.toolResult, (ev: SessionEvent) => {
      this.storage.appendEvent(ev);
    });

    this.ctx.on(this.eventMap.subagentScheduled, (ev: SessionEvent) => {
      this.storage.appendEvent(ev);
      const a = this.sessionAccums.get(ev.sessionId);
      if (a) a.subagents++;
      if (this.capabilities.safety) {
        const r = this.safety.check(ev, a);
        if (!r.ok) this.handleViolations(r.violations);
      }
    });

    this.ctx.on(this.eventMap.contextInjection, (ev: SessionEvent) => {
      this.storage.appendEvent(ev);
    });
  }

  private handleViolations(violations: SafetyViolation[]): void {
    for (const v of violations) {
      if (this.onViolation === 'throw') {
        throw new Error(`[cordishub safety] ${v.kind}: ${v.detail}`);
      } else if (this.onViolation === 'log') {
        console.log(JSON.stringify({ source: 'cordishub.safety', ...v }));
      } else {
        // 默认 warn —— 记录到 storage
        this.storage.appendEvent({
          id: `safety-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId: 'safety',
          source: 'meta',
          ts: Date.now(),
          seq: 0,
          payload: v,
        });
      }
    }
  }

  /** 暴露给外部的便捷方法 —— 用户可在 Web UI 或 CLI 调用 */

  /** 列最近 session */
  recentSessions(limit = 20): SessionT[] {
    return this.storage.recentSessions(limit);
  }

  /** 列出 safety 历史 */
  safetyHistory(opts: { limit?: number } = {}): SafetyViolation[] {
    const all = this.safety.history();
    return opts.limit !== undefined ? all.slice(0, opts.limit) : all;
  }

  /** 全文搜索 */
  search(query: string, opts: { limit?: number } = {}) {
    return this.replay.search(query, opts.limit);
  }

  /** cost breakdown */
  costBreakdown() {
    return this.storage.costBreakdown();
  }

  /** 单 session 的 cost */
  sessionCost(sessionId: string) {
    const breakdown = this.storage.costBreakdown();
    return breakdown.find((b: any) => b.id === sessionId) ?? { id: sessionId, model: 'unknown', totalTokens: 0, totalCost: 0 };
  }

  /** 重新构造一个 session 的状态 —— CLI / Web 都用这个 */
  replaySession(sessionId: string, opts: { upToSeq?: number } = {}): ReplayState {
    return this.replay.reconstruct(sessionId, opts.upToSeq);
  }

  /** 重新构造的内部名（保留向后兼容） */
  reconstruct(sessionId: string, upToSeq?: number): ReplayState {
    return this.replay.reconstruct(sessionId, upToSeq);
  }

  /** diff 两个 session */
  diff(sessionA: string, sessionB: string, opts: DiffOptions): DiffResult {
    return this.replay.diff(sessionA, sessionB, opts);
  }

  /** fork 一个 session —— CLI 友好版（自动生成新 id） */
  fork(sessionA: string, fromSeq: number, newSessionId?: string): SessionT {
    const newId = newSessionId ?? `${sessionA}-fork-${fromSeq}-${Date.now().toString(36)}`;
    return this.replay.fork(sessionA, fromSeq, newId, { model: 'unknown' });
  }

  /** 搜索插件市场（Hub） */
  searchHub(query: string, opts: { onlyOfficial?: boolean; limit?: number } = {}) {
    return this.hub.search({ query, ...opts });
  }

  /** 渲染 Dashboard HTML（CLI 用法：cordishub dashboard） */
  renderDashboard(): string {
    const breakdown = this.storage.costBreakdown();
    const safety = this.safety.history().slice(-20).reverse();
    const sessions = breakdown.map((b: any) => {
      const state = this.replay.reconstruct(b.id);
      return { ...b, eventCount: state.history.length, toolCalls: state.toolCalls.length, userInputs: state.userInputs.length };
    });
    const totalTokens = breakdown.reduce((acc: number, b: any) => acc + (b.totalTokens ?? 0), 0);
    const totalCost = breakdown.reduce((acc: number, b: any) => acc + (b.totalCost ?? 0), 0);

    const color = { green: '#10b981', red: '#ef4444', blue: '#3b82f6', yellow: '#f59e0b' };
    const css = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e6e8ee}a{color:${color.blue};text-decoration:none}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#1a2236;padding:2px 6px;border-radius:4px;font-size:14px}.card{background:#11162a;border:1px solid #1f2640;border-radius:12px;padding:20px;box-shadow:0 1px 0 rgba(255,255,255,.04)}h1,h2,h3{margin:0 0 12px}.grid{display:grid;gap:16px}@media(min-width:900px){.grid-3{grid-template-columns:repeat(3,1fr)}.grid-2{grid-template-columns:2fr 1fr}}.num{font-variant-numeric:tabular-nums;text-align:right}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{padding:8px 12px;border-bottom:1px solid #1f2640;text-align:left}th{color:#aab1c5;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600}.pill.warn{background:${color.yellow}1a;color:${color.yellow}}.pill.block{background:${color.red}1a;color:${color.red}}.pill.ok{background:${color.green}1a;color:${color.green}}`;
    const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>CordisHub Dashboard</title><style>${css}</style></head><body>`;
    const tail = `</body></html>`;
    const body = `
<header style="padding:24px 32px;border-bottom:1px solid #1f2640;background:linear-gradient(180deg,#0e1430,#0b1020)">
  <div style="display:flex;align-items:center;gap:14px">
    <div style="width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,${color.blue},${color.green});display:grid;place-items:center;color:white;font-weight:800">CH</div>
    <div>
      <h1 style="font-size:20px">CordisHub Dashboard</h1>
      <div style="color:#aab1c5;font-size:13px">DeepSeek Harness · 一站式工作台</div>
    </div>
    <div style="margin-left:auto;color:#aab1c5;font-size:12px">${new Date().toISOString()}</div>
  </div>
</header>
<main style="padding:24px 32px;max-width:1280px;margin:0 auto">
  <section class="grid grid-3" style="margin-bottom:24px">
    <div class="card">
      <div style="color:#aab1c5;font-size:12px;text-transform:uppercase;letter-spacing:.05em">Total Sessions</div>
      <div style="font-size:32px;font-weight:700;margin-top:6px">${breakdown.length}</div>
      <div style="color:#aab1c5;font-size:13px;margin-top:4px">All CordisHub-tracked sessions</div>
    </div>
    <div class="card">
      <div style="color:#aab1c5;font-size:12px;text-transform:uppercase;letter-spacing:.05em">Total Tokens</div>
      <div style="font-size:32px;font-weight:700;margin-top:6px">${totalTokens.toLocaleString()}</div>
      <div style="color:#aab1c5;font-size:13px;margin-top:4px">Prompt + completion + reasoning</div>
    </div>
    <div class="card">
      <div style="color:#aab1c5;font-size:12px;text-transform:uppercase;letter-spacing:.05em">Total Cost (USD)</div>
      <div style="font-size:32px;font-weight:700;margin-top:6px;color:${totalCost > 1 ? color.yellow : color.green}">$${totalCost.toFixed(4)}</div>
      <div style="color:#aab1c5;font-size:13px;margin-top:4px">Includes cache reads at $0.07/M</div>
    </div>
  </section>

  <section class="grid grid-2">
    <div class="card">
      <h2>Cost Breakdown</h2>
      <table>
        <thead><tr><th>Session</th><th>Model</th><th class="num">Events</th><th class="num">Tokens</th><th class="num">Cost (USD)</th></tr></thead>
        <tbody>
          ${sessions.map((s: any) => `<tr>
              <td><code>${s.id}</code></td>
              <td>${s.model}</td>
              <td class="num">${s.eventCount}</td>
              <td class="num">${(s.totalTokens ?? 0).toLocaleString()}</td>
              <td class="num">$${(s.totalCost ?? 0).toFixed(4)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Safety Audit</h2>
      ${safety.length === 0
        ? `<div class="pill ok">no violations</div>`
        : `<table>
            <thead><tr><th>Severity</th><th>Kind</th><th>Detail</th></tr></thead>
            <tbody>
              ${safety.map((v: any) => `<tr>
                <td><span class="pill ${v.severity === 'block' ? 'block' : 'warn'}">${v.severity}</span></td>
                <td>${v.kind}</td>
                <td>${v.detail}</td>
              </tr>`).join('')}
            </tbody>
          </table>`}
    </div>
  </section>

  <section style="margin-top:24px" class="card">
    <h2>How to drive this dashboard</h2>
    <ol style="line-height:1.8;color:#cdd2e0">
      <li><code>cordishub hub "review"</code> — 搜索插件市场</li>
      <li><code>cordishub replay &lt;session-id&gt;</code> — 终端回放</li>
      <li><code>cordishub fork &lt;session-id&gt; --at 4</code> — 任意 session 分叉</li>
      <li><code>cordishub cost</code> — 实时成本仪表盘</li>
      <li><code>cordishub safety review</code> — 安全审计历史</li>
    </ol>
  </section>
</main>`;
    return head + body + tail;
  }

  /** 关闭 */
  dispose(): void {
    this.storage.close();
  }
}

/**
 * DSH 插件标准入口
 * 用法（在 dsh.config.ts 里）：
 *
 *   import { apply } from '@cordishub/core'
 *   export default {
 *     plugins: [apply],
 *     // ...其它
 *   }
 */
export function apply(ctx: CordisContextLike, opts?: CordishubOptions): void {
  const service = new CordishubService(ctx, opts);
  service.install();
  ctx['cordishub'] = service;
}