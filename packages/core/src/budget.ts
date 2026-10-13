/**
 * 预算账本 —— 把"事后发现超支"升级为"事前拦截"。
 *
 * 生命周期：模型调用前 reserve（预授权锁定额度）→ 完成后 settle（按实际成本结算，
 * 差额自动释放）→ 失败/超时 release（全额回收）。available = limit - spent - reserved。
 *
 * settle 允许实际成本超过预授权额（模型输出不可精确预知），但 available 会被
 * 钳到 0，后续 reserve 全部被拒 —— 超支只能发生一次，不能连环发生。
 */

export interface LedgerEntry {
  id: string;
  /** 预授权额度（USD） */
  amountUsd: number;
  label?: string;
  state: 'reserved' | 'settled' | 'released';
  /** 结算时的实际成本 */
  actualUsd?: number;
  createdAt: number;
  settledAt?: number;
}

export class BudgetExceededError extends Error {
  readonly requestedUsd: number;
  readonly availableUsd: number;

  constructor(requestedUsd: number, availableUsd: number) {
    super(
      `budget exceeded: requested $${requestedUsd.toFixed(4)}, available $${availableUsd.toFixed(4)}`,
    );
    this.name = 'BudgetExceededError';
    this.requestedUsd = requestedUsd;
    this.availableUsd = availableUsd;
  }
}

export interface BudgetSnapshot {
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  availableUsd: number;
  warn: boolean;
  entries: LedgerEntry[];
}

export class BudgetLedger {
  private entries = new Map<string, LedgerEntry>();
  readonly limitUsd: number;
  readonly warnAtUsd?: number;

  constructor(limitUsd: number, warnAtUsd?: number) {
    this.limitUsd = limitUsd;
    this.warnAtUsd = warnAtUsd;
  }

  /** 预授权：锁定额度。超限抛 BudgetExceededError（调用发生前的硬熔断点） */
  reserve(amountUsd: number, label?: string, now = Date.now()): string {
    if (amountUsd < 0) throw new Error('reserve amount must be >= 0');
    if (amountUsd > this.available()) {
      throw new BudgetExceededError(amountUsd, this.available());
    }
    const id = `rsv-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.entries.set(id, { id, amountUsd, label, state: 'reserved', createdAt: now });
    return id;
  }

  /** 结算：按实际成本入账，锁定额度随之释放；返回入账条目（供持久化） */
  settle(id: string, actualUsd: number, now = Date.now()): LedgerEntry | undefined {
    const e = this.entries.get(id);
    if (!e || e.state !== 'reserved') return undefined;
    e.state = 'settled';
    e.actualUsd = actualUsd;
    e.settledAt = now;
    return e;
  }

  /** 释放：调用失败/取消时全额回收 */
  release(id: string): void {
    const e = this.entries.get(id);
    if (e && e.state === 'reserved') e.state = 'released';
  }

  /**
   * 直接入账（兜底路径）：未走预授权的调用在事后补账。
   * 保证 budget.spent() 与 costBreakdown 永远一致——代价是绕过了事前拦截
   * （调用已发生，只能事后钳 0 阻止后续预授权）。
   */
  charge(amountUsd: number, label?: string, now = Date.now()): LedgerEntry {
    const id = `chg-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: LedgerEntry = {
      id,
      amountUsd: 0,
      label,
      state: 'settled',
      actualUsd: amountUsd,
      createdAt: now,
      settledAt: now,
    };
    this.entries.set(id, entry);
    return entry;
  }

  /**
   * 从持久层恢复历史条目（跨进程预算：limit 作用于累计花费，而非单进程）。
   * 只恢复已结算条目——上个进程的悬挂预授权对应的调用已不存在，恢复只会锁死额度。
   */
  restoreEntries(entries: Array<LedgerEntry>): number {
    let restored = 0;
    for (const e of entries) {
      if (e && typeof e.id === 'string' && e.state === 'settled') {
        this.entries.set(e.id, e);
        restored++;
      }
    }
    return restored;
  }

  /** 兜底：回收超过 ttl 的悬挂预授权（拿到结果但忘记结算的防护网） */
  releaseStale(ttlMs: number, now = Date.now()): number {
    let released = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'reserved' && now - e.createdAt > ttlMs) {
        e.state = 'released';
        released++;
      }
    }
    return released;
  }

  /** 已结算的实际花费 */
  spent(): number {
    let sum = 0;
    for (const e of this.entries.values()) if (e.state === 'settled') sum += e.actualUsd ?? 0;
    return sum;
  }

  /** 未结算的锁定额度 */
  reserved(): number {
    let sum = 0;
    for (const e of this.entries.values()) if (e.state === 'reserved') sum += e.amountUsd;
    return sum;
  }

  /** 剩余可用（钳 0：超支一次后不再放行新预授权） */
  available(): number {
    return Math.max(0, this.limitUsd - this.spent() - this.reserved());
  }

  /** 触达软告警阈值 */
  overWarnThreshold(): boolean {
    if (this.warnAtUsd === undefined) return false;
    return this.spent() + this.reserved() >= this.warnAtUsd;
  }

  snapshot(): BudgetSnapshot {
    return {
      limitUsd: this.limitUsd,
      spentUsd: this.spent(),
      reservedUsd: this.reserved(),
      availableUsd: this.available(),
      warn: this.overWarnThreshold(),
      entries: [...this.entries.values()],
    };
  }
}
