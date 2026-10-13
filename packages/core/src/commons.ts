/**
 * 轨迹公地（Genesis G4）—— 脱敏 + taint 门控的轨迹共享，经验产生复利。
 *
 * 激活条件的运行时实现（同 G3 的纪律解法）：
 *   - 默认不出本机：exportBundle 是唯一出口，且必须通过同意门；
 *   - 同意门 = taint 系统复用：防跨租户缓存泄漏的同一套标签机制，现在决定
 *     什么允许离开本机——activeTaints ⊄ consent.allowTaints 即拒绝导出；
 *   - 剔除（redact）：用户原文等敏感来源可在导出时整体剔除，结构保留价值；
 *   - 完整性：bundle 核心 canonical 化后 ed25519 签名，导入端经 TrustRegistry
 *     的密钥轮换/退休/吊销语义验签，内容篡改 → contentHash 失配即拒。
 *
 * 诚实边界（女巫攻击）：本地只做密码学完整性与发布者信任；对抗刷量需要
 * 声誉网络（生态层，出仓库范围）。传输层同样不在此——bundle 是数据对象，
 * 怎么发是人的事。
 */
import { createHash } from 'node:crypto';
import type { Storage } from './storage.ts';
import type { ReplayEngine } from './replay.ts';
import { recordTape, type CassetteTape, type CassetteEntry } from './cassette.ts';
import { extractGenomeFromSession, hashGenome, saveGenome, fitnessOf, type AgentGenome, type GenomeFitness } from './genome.ts';
import { signData, type TrustRegistry, type VerifyDecision } from './manifest.ts';
import type { SessionEvent, EventSource } from './types.ts';

export interface CommonsConsent {
  /** 允许离开本机的污点标签（taint 复用为同意系统） */
  allowTaints: string[];
  /** 导出剔除：按盒带条目种类（'context' | 'model' | 'tool-call' | 'tool-result'）与上下文来源 */
  redact?: { eventKinds?: string[]; contextSources?: string[] };
  /** 过期时间（毫秒时间戳）——导入端拒收过期包裹 */
  expiresAt: number;
  purpose?: string;
}

export interface CommonsBundle {
  format: 'cordishub-commons/1';
  bundleId: string;
  originSessionId: string;
  publisher: string;
  exportedAt: number;
  consent: CommonsConsent;
  tape: CassetteTape;
  genome?: AgentGenome;
  fitness?: GenomeFitness;
  redaction: { removedEntries: number };
  contentHash: string;
  signature: string;
}

export class CommonsConsentError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`consent gate refused export: taints not covered [${violations.join(', ')}]`);
    this.name = 'CommonsConsentError';
    this.violations = violations;
  }
}

export class CommonsVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommonsVerifyError';
  }
}

/** bundle 核心的稳定序列化（导出/导入两端共用，内容哈希与签名都基于它） */
function canonicalCore(core: Omit<CommonsBundle, 'bundleId' | 'contentHash' | 'signature'>): string {
  return JSON.stringify(core);
}

function hashOf(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * 导出轨迹包裹。同意门：调用方先用自己的污点策略跑 taintScan（策略即代码，
 * 不出边界），把活跃标签传入——未覆盖的标签直接抛 CommonsConsentError。
 * 本函数不写任何存储（导出是纯函数；落不落地、发不发出，是调用方的事）。
 */
export function exportBundle(
  sessionId: string,
  storage: Storage,
  replay: ReplayEngine,
  opts: {
    consent: CommonsConsent;
    publisher: string;
    activeTaints: string[];
    signWith: { privateKeyBase64: string };
    includeGenome?: boolean;
  },
): CommonsBundle {
  const tape = recordTape(sessionId, storage, replay);
  if (!tape) throw new CommonsVerifyError(`session not found: ${sessionId}`);

  const allowed = new Set(opts.consent.allowTaints);
  const violations = opts.activeTaints.filter((t) => !allowed.has(t));
  if (violations.length > 0) throw new CommonsConsentError(violations);

  const redactKinds = new Set(opts.consent.redact?.eventKinds ?? []);
  const redactSources = new Set(opts.consent.redact?.contextSources ?? []);
  const kept: CassetteEntry[] = [];
  let removedEntries = 0;
  for (const e of tape.entries) {
    const kindHit = redactKinds.has(e.kind);
    const sourceHit = e.kind === 'context' && redactSources.has(e.source);
    if (kindHit || sourceHit) {
      removedEntries++;
    } else {
      kept.push(e);
    }
  }

  const includeGenome = opts.includeGenome ?? true;
  const genome = includeGenome ? extractGenomeFromSession(sessionId, storage, replay) : undefined;
  const fitness = genome ? fitnessOf(storage, hashGenome(genome)) : undefined;

  const exportedTape: CassetteTape = { ...tape, entries: kept, sessionId };
  const core = {
    format: 'cordishub-commons/1' as const,
    originSessionId: sessionId,
    publisher: opts.publisher,
    exportedAt: Date.now(),
    consent: opts.consent,
    tape: exportedTape,
    genome,
    fitness,
    redaction: { removedEntries },
  };
  const canonical = canonicalCore(core);
  const contentHash = hashOf(canonical);
  return {
    ...core,
    bundleId: `cmn-${contentHash.slice(0, 12)}`,
    contentHash,
    signature: signData(canonical, opts.signWith.privateKeyBase64),
  };
}

/** 校验包裹：格式 / 过期 / 内容哈希（防篡改）/ 发布者信任（密钥轮换语义） */
export function verifyBundle(
  bundle: CommonsBundle,
  trust: TrustRegistry,
  opts: { now?: number } = {},
): VerifyDecision {
  const now = opts.now ?? Date.now();
  if (bundle.format !== 'cordishub-commons/1') {
    throw new CommonsVerifyError(`unsupported bundle format: ${bundle.format}`);
  }
  if (now > bundle.consent.expiresAt) {
    throw new CommonsVerifyError('bundle consent expired');
  }
  const { bundleId: _b, contentHash: _c, signature: _s, ...core } = bundle;
  const canonical = canonicalCore(core);
  if (hashOf(canonical) !== bundle.contentHash) {
    throw new CommonsVerifyError('content hash mismatch: bundle tampered');
  }
  // 回溯判定：以导出时刻验证发布者密钥（退休/吊销按导出时间点计）
  return trust.verifyRaw(bundle.publisher, canonical, bundle.signature, { at: bundle.exportedAt });
}

/** 导入包裹：验签后物化为本地 session（谱系指向来源），此后可回放/分叉/育种 */
export function importBundle(
  bundle: CommonsBundle,
  storage: Storage,
  opts: { trust: TrustRegistry; newSessionId?: string; now?: number },
): { sessionId: string; events: number; removedEntries: number; decision: VerifyDecision } {
  const decision = verifyBundle(bundle, opts.trust, { now: opts.now });
  if (!decision.ok) {
    throw new CommonsVerifyError(`publisher trust rejected: ${decision.reason}`);
  }

  const newId = opts.newSessionId ?? `${bundle.originSessionId}@${bundle.bundleId.slice(4, 10)}`;
  let seq = 0;
  const events: SessionEvent[] = [];
  for (const e of bundle.tape.entries) {
    seq++;
    const base = { id: `${newId}-e${seq}`, sessionId: newId, ts: e.ts, seq };
    if (e.kind === 'model') {
      events.push({ ...base, source: 'model', model: e.model, payload: { text: e.text } });
    } else if (e.kind === 'tool-call') {
      // toolCallId 用盒带条目的原始 seq：call 与 result 共享同一 seq → 稳定配对
      events.push({ ...base, source: 'tool', toolCallId: `imp-${e.seq}`, payload: { tool_name: e.tool, arguments: e.args } });
    } else if (e.kind === 'tool-result') {
      events.push({ ...base, source: 'tool', toolCallId: `imp-${e.seq}`, payload: { tool_name: e.tool, result: e.result } });
    } else {
      events.push({ ...base, source: e.source as EventSource, payload: { text: e.text } });
    }
  }

  storage.beginSession({
    id: newId,
    startedAt: opts.now ?? Date.now(),
    model: bundle.genome?.model ?? 'unknown',
    totalTokens: 0,
    totalCost: 0,
    meta: {
      commons: {
        bundleId: bundle.bundleId,
        publisher: bundle.publisher,
        originSessionId: bundle.originSessionId,
        purpose: bundle.consent.purpose,
      },
      ...(bundle.genome ? { genome: { hash: hashGenome(bundle.genome) } } : {}),
    },
  });
  for (const ev of events) storage.appendEvent(ev);
  if (bundle.genome) saveGenome(storage, bundle.genome);

  return { sessionId: newId, events: events.length, removedEntries: bundle.redaction.removedEntries, decision };
}
