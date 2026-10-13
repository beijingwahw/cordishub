/**
 * Taint 污点追踪（粗粒度）—— 把"跨租户污染"从命名空间约定变成信息流检查。
 *
 * 模型：污点标签（tenant:acme / pii / secret / consent:...）附着在工具结果与
 * 上下文注入上，沿事件流传播（被消费即进入活跃集，模型输出继承之），
 * 清洗屏障（如 redact 工具）将其清空。三个用途：
 *   1. 缓存兼容检查（prompt-cache 复用满足子集规则，跨租户强制 MISS）
 *   2. 输出污点门控（禁止外流标签在模型输出时活跃 → taint-leak 违规）
 *   3. 同意系统（标签任意，consent:* 同机制复用——G4 轨迹公地的隐私底座）
 *
 * 诚实边界：粗粒度——污点在"状态层"传播，不做 token 级数据流分析；
 * 误报（保守方向）可接受，漏报由清洗屏障的显式声明兜底。
 */
import type { Storage } from './storage.ts';
import type { SessionEvent, EventSource } from './types.ts';

export type TaintLabel = string;

export interface TaintPolicy {
  /** 工具结果 → 污点标签（粗粒度判定） */
  taintOfToolResult?: (tool: string, result: unknown) => TaintLabel[];
  /** 其它事件来源（context 注入租户数据等）→ 污点标签 */
  taintOfEvent?: (source: EventSource, payload: Record<string, unknown>) => TaintLabel[];
  /** 清洗屏障：返回 true 表示该工具结果清空全部活跃污点 */
  sanitize?: (tool: string, result: unknown) => boolean;
  /** 禁止出现在模型输出状态的标签（输出污点门控） */
  forbiddenInOutput?: TaintLabel[];
}

/** 缺省策略：session 级租户污点；名字含 redact/sanitize/scrub 的工具是清洗屏障 */
export function tenantTaintPolicy(tenant: string): TaintPolicy {
  return {
    taintOfToolResult: () => [`tenant:${tenant}`],
    sanitize: (tool) => /redact|sanitiz|scrub/i.test(tool),
  };
}

export interface TaintProvenance {
  label: TaintLabel;
  seq: number;
  eventId: string;
  via: string;
}

export interface TaintViolation {
  kind: 'taint-leak';
  label: TaintLabel;
  atSeq: number;
  eventId: string;
  detail: string;
}

export interface TaintTimelinePoint {
  seq: number;
  added: TaintLabel[];
  removed: TaintLabel[];
  active: TaintLabel[];
}

export interface TaintReport {
  finalActive: TaintLabel[];
  timeline: TaintTimelinePoint[];
  provenance: TaintProvenance[];
  violations: TaintViolation[];
  eventsScanned: number;
}

export class TaintTracker {
  private policy: TaintPolicy;
  private active = new Set<TaintLabel>();
  private provenance: TaintProvenance[] = [];
  private violations: TaintViolation[] = [];
  private timeline: TaintTimelinePoint[] = [];

  constructor(policy: TaintPolicy) {
    this.policy = policy;
  }

  /** 增量折叠一个事件，返回该时刻的污点快照 */
  fold(ev: SessionEvent): TaintTimelinePoint {
    const p = ev.payload as Record<string, unknown>;
    const added: TaintLabel[] = [];
    const removed: TaintLabel[] = [];

    if (ev.source === 'tool') {
      const tool = typeof p['tool_name'] === 'string' ? p['tool_name'] : 'unknown';
      const hasResult = p['result'] !== undefined || p['stdout'] !== undefined;
      if (hasResult) {
        const result = p['result'] ?? { stdout: p['stdout'] };
        if (this.policy.sanitize?.(tool, result)) {
          for (const label of this.active) removed.push(label);
          this.active.clear();
        } else {
          for (const label of this.policy.taintOfToolResult?.(tool, result) ?? []) {
            this.add(label, ev, `tool:${tool}`, added);
          }
        }
      }
    } else {
      for (const label of this.policy.taintOfEvent?.(ev.source, p) ?? []) {
        this.add(label, ev, ev.source, added);
      }
    }

    // 输出污点门控：模型输出发生时，活跃污点含禁止标签 → 违规（保守方向：宁可误报）
    if (ev.source === 'model') {
      for (const forbidden of this.policy.forbiddenInOutput ?? []) {
        if (this.active.has(forbidden)) {
          this.violations.push({
            kind: 'taint-leak',
            label: forbidden,
            atSeq: ev.seq,
            eventId: ev.id,
            detail: `model output at seq ${ev.seq} may carry forbidden taint "${forbidden}" (source: ${this.provenanceOf(forbidden)})`,
          });
        }
      }
    }

    const point: TaintTimelinePoint = { seq: ev.seq, added, removed, active: [...this.active] };
    this.timeline.push(point);
    return point;
  }

  private add(label: TaintLabel, ev: SessionEvent, via: string, added: TaintLabel[]): void {
    if (this.active.has(label)) return;
    this.active.add(label);
    added.push(label);
    this.provenance.push({ label, seq: ev.seq, eventId: ev.id, via });
  }

  private provenanceOf(label: TaintLabel): string {
    const last = [...this.provenance].reverse().find((x) => x.label === label);
    return last ? `${last.via} @seq${last.seq}` : 'unknown';
  }

  report(eventsScanned: number): TaintReport {
    return {
      finalActive: [...this.active],
      timeline: [...this.timeline],
      provenance: [...this.provenance],
      violations: [...this.violations],
      eventsScanned,
    };
  }
}

/** 单遍扫描一个 session 的污点流（session 不存在返回 undefined） */
export function taintScan(sessionId: string, storage: Storage, policy: TaintPolicy): TaintReport | undefined {
  if (!storage.getSession(sessionId)) return undefined;
  const tracker = new TaintTracker(policy);
  const events = storage.getEvents(sessionId);
  for (const ev of events) tracker.fold(ev);
  return tracker.report(events.length);
}

/**
 * 缓存兼容检查（子集规则 / no-read-up）：
 * 请求只能消费"污点集 ⊆ 自身污点集"的缓存。
 * 同租户：{tenant:A} ⊆ {tenant:A, pii} → 兼容；
 * 跨租户：{tenant:A} ⊄ {tenant:B} → 强制 MISS——prompt-cache 污染在结构上不可能。
 */
export function cacheTaintCompatible(cacheTaints: TaintLabel[], requestTaints: TaintLabel[]): boolean {
  const request = new Set(requestTaints);
  return cacheTaints.every((t) => request.has(t));
}
