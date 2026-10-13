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
import { escapeHtml } from './html.ts';
import { BudgetLedger, BudgetExceededError, type LedgerEntry } from './budget.ts';
import type { VerifyReport } from './merkle.ts';
import {
  recordTape,
  playCounterfactual,
  bisectFirstBad,
  certifyDeterminism,
  type CassetteTape,
  type CounterfactualModel,
  type CounterfactualResult,
  type BisectResult,
  type DeterminismCertificate,
} from './cassette.ts';
import {
  runReactor,
  evolve,
  type ReactorVariant,
  type ReactorReport,
  type ReactorFitness,
  type ReactorCostOf,
  type EvolutionReport,
  type SelectionStrategy,
} from './reactor.ts';
import { taintScan, type TaintPolicy, type TaintReport } from './taint.ts';
import { syncHubTopic, syncHubTopics, githubTopicFetcher } from './hubsync.ts';
import {
  extractGenomeFromSession,
  mutate,
  saveGenome,
  loadGenomes,
  fitnessOf,
  type AgentGenome,
  type GenomeMutation,
  type GenomeFitness,
} from './genome.ts';
import { CostEngine, type CostOutput, type ModelRate } from './cost.ts';
import { ReplayEngine, type ReplayState, type DiffResult, type DiffOptions } from './replay.ts';
import { HubIndex, type PluginMeta, type SearchOptions, DEMO_PLUGINS } from './hub.ts';
import { SafetyNet, type SafetyPolicy, type SafetyCheckResult, type SafetyViolation } from './safety.ts';
import type { Session as SessionT, SessionEvent, SessionCheckpoint } from './types.ts';

export interface CordishubOptions {
  /** SQLite 文件路径 */
  dbPath?: string;
  /** 静默模式（不向 stderr 输出 [storage] 日志，CLI 场景建议开启） */
  silent?: boolean;
  /** v0.4 · 哈希链封印频率：每 N 个数据行自动封印（默认 50；0 = 关闭） */
  sealEvery?: number;
  /** 自定义费率表 */
  rates?: ModelRate[];
  /** 启用哪些能力（默认全开） */
  capabilities?: CapabilityFlag;
  /** 单租户安全策略 */
  safetyPolicy?: Partial<SafetyPolicy>;
  /** 是否吞掉 SafetyNet 抛出的违规（默认 true：warn + 记录，false：抛错） */
  onViolation?: 'warn' | 'log' | 'throw';
  /** v0.2 · 预算预授权：启用后模型调用前 reserve、完成后 settle、超限在调用发生前拦截 */
  budget?: {
    limitUsd: number;
    /** 软告警阈值 */
    warnAtUsd?: number;
    /** 模型未知时的预授权额度兜底（美元）；已知模型按费率 × token 上限估算 */
    reserveEstimateUsd?: number;
    /** 预授权额度估算的 token 上限（默认 prompt 32768 / completion 8192） */
    reserveCaps?: { promptTokens?: number; completionTokens?: number };
  };
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
  /** 模型调用前（预算预授权钩子；不落盘，真正的调用记录在 modelResponse） */
  modelRequest: string;
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
  modelRequest: 'model/request',
  modelResponse: 'model/response',
  toolCall: 'tool/called',
  toolResult: 'tool/result',
  subagentScheduled: 'subagent/scheduled',
  contextInjection: 'context/injection',
};

/**
 * 归一化 sessionEnd 事件的载荷。DSH 不同版本 / 不同接入方式下观察到两种形态：
 *   - ('sess-001', 1760000000000)            两参形式（demo、CLI 集成）
 *   - ({ id: 'sess-001', ts }) / Session 对象  事件流对象透传形式
 */
function parseSessionEndArgs(args: unknown[]): { sessionId?: string; endedAt: number } {
  const [first, second] = args;
  if (typeof first === 'string') {
    return { sessionId: first, endedAt: typeof second === 'number' ? second : Date.now() };
  }
  if (first !== null && typeof first === 'object') {
    const obj = first as Record<string, unknown>;
    const id = obj.id ?? obj.sessionId;
    const ts = [obj.ts, obj.endedAt, second].find((v) => typeof v === 'number');
    if (typeof id === 'string') {
      return { sessionId: id, endedAt: (ts as number | undefined) ?? Date.now() };
    }
  }
  return { sessionId: undefined, endedAt: Date.now() };
}

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
  /** v0.2 · 预算账本（提供 budget 选项即启用预授权硬熔断） */
  readonly budget?: BudgetLedger;
  private reserveEstimateUsd = 0.1;
  private reserveCaps: { promptTokens: number; completionTokens: number } = {
    promptTokens: 32768,
    completionTokens: 8192,
  };
  private sessionAccums = new Map<
    string,
    { tokens: number; cost: number; subagents: number; reservations: string[] }
  >();

  constructor(ctx: CordisContextLike, opts: CordishubOptions = {}) {
    this.ctx = ctx;
    this.storage = new Storage({
      path: opts.dbPath ?? './cordish.db',
      silent: opts.silent ?? false,
      sealEvery: opts.sealEvery,
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
    if (opts.budget) {
      this.budget = new BudgetLedger(opts.budget.limitUsd, opts.budget.warnAtUsd);
      this.reserveEstimateUsd = opts.budget.reserveEstimateUsd ?? 0.1;
      this.reserveCaps = { ...this.reserveCaps, ...opts.budget.reserveCaps };
    }
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

    // Hub：先恢复持久化索引，再叠加内置 demo 数据（真实场景从 GitHub GraphQL 拉取）
    if (this.capabilities.hub) {
      this.hub.load();
      this.hub.ingest(DEMO_PLUGINS);
    }

    if (this.capabilities.replay || this.capabilities.cost || this.capabilities.safety) {
      this.attachListeners();
    }

    // 恢复历史 safety 违规（持久化在 events 文件里 sessionId='safety' 的 meta 事件），
    // 使 dashboard / `cordishub safety review` 重启后仍能看到完整审计历史
    if (this.capabilities.safety) {
      const stored = this.storage
        .getEvents('safety')
        .map((e) => e.payload as unknown as SafetyViolation)
        .filter((v) => v && typeof v.kind === 'string' && typeof v.detail === 'string');
      if (stored.length > 0) this.safety.restore(stored);
    }

    // 跨进程预算：从 KV 持久层恢复已结算历史（limit 作用于累计花费，而非本进程）
    if (this.budget) {
      this.budget.restoreEntries(this.storage.listKv<LedgerEntry>('budget').map((x) => x.value));
    }
  }

  private attachListeners(): void {
    // session 开始
    this.ctx.on(this.eventMap.sessionStart, (sess: SessionT) => {
      this.storage.beginSession(sess);
      this.sessionAccums.set(sess.id, { tokens: 0, cost: 0, subagents: 0, reservations: [] });
    });

    // session 结束（两种载荷形态都接受，见 parseSessionEndArgs）
    this.ctx.on(this.eventMap.sessionEnd, (...args: unknown[]) => {
      const { sessionId, endedAt } = parseSessionEndArgs(args);
      if (sessionId === undefined) return;
      // 回收该 session 未结算的预授权（调用中途流产的兜底）
      const a = this.sessionAccums.get(sessionId);
      if (this.budget && a) {
        for (const id of a.reservations) this.budget.release(id);
      }
      this.storage.endSession(sessionId, endedAt);
      this.sessionAccums.delete(sessionId);
    });

    // 模型调用前：预算预授权（v0.2 硬熔断——超限在调用发生前被拒绝，而非事后发现）
    this.ctx.on(this.eventMap.modelRequest, (ev: SessionEvent) => {
      if (!this.budget) return;
      // 未注册的 session 不预授权：reserve 了无法归属，额度会被永久锁死；
      // 其调用成本在 modelResponse 时走 charge() 直接入账
      const a = this.sessionAccums.get(ev.sessionId);
      if (!a) return;
      try {
        const id = this.budget.reserve(this.estimateFor(ev.model), `model:${ev.sessionId}`);
        a.reservations.push(id);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          const violation: SafetyViolation = {
            kind: 'budget-cap',
            detail: `pre-auth rejected: ${err.message}`,
            ts: Date.now(),
            severity: 'block',
          };
          this.safety.record(violation);
          this.handleViolations([violation]);
        } else {
          throw err;
        }
      }
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
          if (this.budget) {
            let entry: LedgerEntry | undefined;
            if (a.reservations.length > 0) {
              // 结算预授权：按实际成本入账，锁定额度随之释放（FIFO）
              entry = this.budget.settle(a.reservations.shift()!, cost.total);
            } else {
              // 未走 model/request 的调用（接入方未实现预授权钩子）：直接入账，
              // 保证账本与成本投影一致
              entry = this.budget.charge(cost.total, `model:${ev.sessionId}`);
            }
            // 账本是日志的 fold：已结算条目落 KV，重启后恢复累计花费
            if (entry) this.storage.writeKv('budget', entry.id, entry);
          }
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
      // 三种模式都持久化（throw 前也落盘），重启后审计历史不丢
      this.storage.appendEvent({
        id: `safety-${v.ts}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId: 'safety',
        source: 'meta',
        ts: v.ts,
        seq: 0,
        payload: { ...v },
      });
      if (this.onViolation === 'throw') {
        throw new Error(`[cordishub safety] ${v.kind}: ${v.detail}`);
      } else if (this.onViolation === 'log') {
        console.log(JSON.stringify({ source: 'cordishub.safety', ...v }));
      }
    }
  }

  /** 模型感知的预授权额度：费率 × token 上限；未知模型退回固定额度兜底 */
  private estimateFor(model: string | undefined): number {
    if (model) {
      const rate = this.costEngine.rateFor(model);
      if (rate) {
        const reasoning = rate.reasoningPerMillion ?? rate.completionPerMillion;
        const estimate =
          (rate.promptPerMillion * this.reserveCaps.promptTokens +
            rate.completionPerMillion * this.reserveCaps.completionTokens +
            reasoning * this.reserveCaps.completionTokens) /
          1e6;
        // 下限 $0.001：极廉价模型的估算可能趋近 0，零额度预授权永远不会触发熔断
        return Math.max(estimate, 0.001);
      }
    }
    return this.reserveEstimateUsd;
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

  /** fork 一个 session —— CLI 友好版（自动生成新 id）；options 省略时继承原 session 的模型 */
  fork(
    sessionA: string,
    fromSeq: number,
    newSessionId?: string,
    options?: { model?: string; label?: string; genome?: { hash: string; name?: string } },
  ): SessionT {
    const newId = newSessionId ?? `${sessionA}-fork-${fromSeq}-${Date.now().toString(36)}`;
    return this.replay.fork(sessionA, fromSeq, newId, options);
  }

  /** 在某个 seq 打一个 checkpoint（time-travel / fork 的锚点，落盘到 .checkpoints.jsonl） */
  checkpoint(sessionId: string, seq: number, message?: string): SessionCheckpoint | undefined {
    const ev = this.storage.getEvents(sessionId).find((e) => e.seq === seq);
    if (!ev) return undefined;
    const cp: SessionCheckpoint = { sessionId, eventId: ev.id, seq, ts: ev.ts, message };
    this.storage.checkpoint(cp);
    return cp;
  }

  /** ===== G0 · 基因维度 ===== */

  /** 从一个 session 提取可遗传的基因型（日志 → 基因型的投影） */
  extractGenome(sessionId: string, opts: { name?: string; version?: string } = {}): AgentGenome | undefined {
    return extractGenomeFromSession(sessionId, this.storage, this.replay, opts);
  }

  /**
   * 育种：提取 → 依序应用变异 → 持久化（父代与子代都入 KV 基因库）。
   * 变异是纯函数，父代不可变；子代自动携带谱系指纹与版本 bump。
   */
  breed(sessionId: string, mutations: GenomeMutation[], opts: { name?: string; version?: string } = {}): AgentGenome | undefined {
    const parent = this.extractGenome(sessionId, opts);
    if (!parent) return undefined;
    saveGenome(this.storage, parent);
    let child = parent;
    for (const m of mutations) child = mutate(child, m);
    saveGenome(this.storage, child);
    return child;
  }

  /** 谱系适应度：聚合携带该基因标记的 session 的成本 fold（进化的评分系统） */
  genomeFitness(genomeHash: string): GenomeFitness {
    return fitnessOf(this.storage, genomeHash);
  }

  /** v0.4 · 防篡改审计：全量验证四个日志文件的哈希链 */
  audit(): VerifyReport[] {
    return this.storage.verifyChains();
  }

  /** v0.4 · 立即封印（session 结束 / 导出链头前调用） */
  sealNow(): void {
    this.storage.sealNow();
  }

  /** ===== L1 · Cassette 确定性回放 ===== */

  /** 录制一个 session 的盒带（非确定性输入清单） */
  recordTape(sessionId: string): CassetteTape | undefined {
    return recordTape(sessionId, this.storage, this.replay);
  }

  /**
   * 反事实重放：从 fromSeq 起用注入的模型重跑，工具响应取自盒带（上下文确定性）。
   * fault 可在第 N 个工具响应上注入篡改/错误，报告与录制轨迹的分叉点。
   */
  counterfactual(
    sessionId: string,
    opts: { model: CounterfactualModel; fault?: Parameters<typeof playCounterfactual>[1]['fault']; fromSeq?: number; maxSteps?: number },
  ): CounterfactualResult | undefined {
    const tape = this.recordTape(sessionId);
    if (!tape) return undefined;
    return playCounterfactual(tape, opts);
  }

  /** 因果二分：O(log n) 状态重构，找到最早使谓词为真的 seq（"从哪步走偏"） */
  bisect(sessionId: string, isBad: (state: import('./replay.ts').ReplayState) => boolean): BisectResult {
    return bisectFirstBad(sessionId, this.storage, this.replay, isBad);
  }

  /** 颁发确定性证书：档位分级（empty/context/full）+ 可选重放稳定性证明 */
  certifyTape(
    sessionId: string,
    opts: { model?: CounterfactualModel; stabilityRuns?: number } = {},
  ): DeterminismCertificate | undefined {
    const tape = this.recordTape(sessionId);
    if (!tape) return undefined;
    return certifyDeterminism(tape, opts);
  }

  /** v0.7 · 污点扫描：粗粒度信息流检查（传播 / 溯源 / 清洗屏障 / 输出门控） */
  taintScan(sessionId: string, policy: TaintPolicy): TaintReport | undefined {
    return taintScan(sessionId, this.storage, policy);
  }

  /**
   * v0.9 · Hub 数据源管道：按 GitHub topic 同步插件索引（fetcher 可注入）。
   * 生产用 githubTopicFetcher(token)；测试用 mock fetcher。
   */
  async syncHub(opts: { token?: string; topic?: string; maxPages?: number } = {}): Promise<number> {
    return syncHubTopic(this.hub, {
      fetcher: githubTopicFetcher(opts.token),
      topic: opts.topic,
      maxPages: opts.maxPages,
    });
  }

  /**
   * v0.10 · 多 topic 真实索引：按 topic 依次同步，标签记录来源，
   * 同名仓库按 fullName 去重。返回按 topic 计数（fetched 口径）。
   */
  async syncHubTopics(
    opts: {
      token?: string;
      topics: string[];
      maxPages?: number;
      onProgress?: (topic: string, fetched: number) => void;
    } = { topics: ['dsh-plugin'] },
  ): Promise<{ total: number; byTopic: Record<string, number> }> {
    return syncHubTopics(this.hub, {
      fetcher: githubTopicFetcher(opts.token),
      topics: opts.topics,
      maxPages: opts.maxPages,
      onProgress: opts.onProgress,
    });
  }

  /** ===== G1 · 进化反应堆 ===== */

  /**
   * 变体跑批：从 session 提取种子基因 → 逐变体变异 → 燃料预授权 → 盒带重放
   * （注入 harness 作为变体的"模型"）→ 按实际成本结算 → 适应度选择。
   * 预算耗尽的变体被拒绝（budgetExhausted），进化不会失控。
   */
  reactor(sessionId: string, opts: {
    variants: ReactorVariant[];
    harness: (genome: import('./genome.ts').AgentGenome) => CounterfactualModel;
    fitness?: ReactorFitness;
    costOf?: ReactorCostOf;
    /** 燃料闸门（独立账本，不与运行时预算混用）；缺省 limitUsd=1 */
    budget?: { limitUsd: number; fuelPerRunUsd?: number };
    maxSteps?: number;
    fromSeq?: number;
    /** 变体入 KV 基因库 */
    save?: boolean;
  }): ReactorReport | undefined {
    const tape = this.recordTape(sessionId);
    const seed = this.extractGenome(sessionId);
    if (!tape || !seed) return undefined;
    const ledger = new BudgetLedger(opts.budget?.limitUsd ?? 1);
    return runReactor({
      seed,
      variants: opts.variants,
      tape,
      harness: opts.harness,
      fitness: opts.fitness,
      costOf: opts.costOf,
      budget: ledger,
      fuelPerRunUsd: opts.budget?.fuelPerRunUsd,
      maxSteps: opts.maxSteps,
      fromSeq: opts.fromSeq,
      storage: opts.save ? this.storage : undefined,
    });
  }

  /**
   * 世代进化（G1.5）：选择 → 变异 → 下一代，燃料跨世代共享（总预算 = 进化总闸门）。
   * 缺省种子化 RNG（seededRng(42)），进化实验可复现。
   */
  evolve(sessionId: string, opts: {
    generations: number;
    populationSize: number;
    mutationPool: import('./genome.ts').GenomeMutation[];
    harness: (genome: import('./genome.ts').AgentGenome) => CounterfactualModel;
    fitness?: ReactorFitness;
    costOf?: ReactorCostOf;
    budget?: { limitUsd: number; fuelPerRunUsd?: number };
    maxSteps?: number;
    fromSeq?: number;
    save?: boolean;
    rng?: () => number;
    eliteSize?: number;
    selection?: SelectionStrategy;
  }): EvolutionReport | undefined {
    const tape = this.recordTape(sessionId);
    const seed = this.extractGenome(sessionId);
    if (!tape || !seed) return undefined;
    const ledger = new BudgetLedger(opts.budget?.limitUsd ?? 1);
    return evolve({
      seed,
      generations: opts.generations,
      populationSize: opts.populationSize,
      mutationPool: opts.mutationPool,
      tape,
      harness: opts.harness,
      budget: ledger,
      fitness: opts.fitness,
      costOf: opts.costOf,
      fuelPerRunUsd: opts.budget?.fuelPerRunUsd,
      maxSteps: opts.maxSteps,
      fromSeq: opts.fromSeq,
      storage: opts.save ? this.storage : undefined,
      rng: opts.rng,
      eliteSize: opts.eliteSize,
      selection: opts.selection,
    });
  }

  /** 搜索插件市场（Hub） */
  searchHub(query: string, opts: { onlyOfficial?: boolean; limit?: number } = {}) {
    return this.hub.search({ query, ...opts });
  }

  /** 渲染 Dashboard HTML（CLI 用法：cordishub dashboard） */
  renderDashboard(): string {
    const esc = escapeHtml;
    const breakdown = this.storage.costBreakdown();
    const chains = this.storage.verifyChains();
    const chainOk = chains.filter((c) => c.ok).length;
    const genomeCount = loadGenomes(this.storage).length;
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
              <td><code>${esc(s.id)}</code></td>
              <td>${esc(s.model)}</td>
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
                <td><span class="pill ${v.severity === 'block' ? 'block' : 'warn'}">${esc(v.severity)}</span></td>
                <td>${esc(v.kind)}</td>
                <td>${esc(v.detail)}</td>
              </tr>`).join('')}
            </tbody>
          </table>`}
    </div>
  </section>

  <section style="margin-top:24px" class="card">
    <h2>Kernel</h2>
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
      <span class="pill ${chainOk === chains.length ? 'ok' : 'block'}">chain ${chainOk}/${chains.length} ok</span>
      <span class="pill ok">gene library ${genomeCount}</span>
      <span class="pill ok">rpc bridge ready</span>
      <span style="color:#aab1c5;font-size:13px">Merkle 封印 · 基因谱系 · JSON-RPC 方法表 · taint 信息流</span>
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