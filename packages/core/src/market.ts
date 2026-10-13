/**
 * 内部市场（Genesis G3）—— 预算预授权的市场化一般化。
 *
 * 维度激活纪律的运行时实现：市场不需要预先决定"开不开"——
 *   - 无争抢（容量足够）：bid() 立即全额授予，语义与 BudgetLedger.reserve 完全一致（配给制，零开销）；
 *   - 争抢出现（容量不足）：竞标入队，clear() 触发加权拍卖——
 *       有效权重 = weight + 等待轮数 × aging（防饿死），
 *       依序全额授予，容量尾部给部分授予，授予不了的继续排队等结算释放。
 *
 * 红线（docs/DESIGN.md）：本市场是内部记账单位，绝不通向代币/投机——
 * 没有转让、没有二级市场、没有价格发现，只有调度。
 */
export interface MarketBid {
  bidder: string;
  amountUsd: number;
  /** 支付意愿权重（谱系适应度 / 任务优先级 / 租户等级），缺省 1 */
  weight?: number;
  /** 低于此值的授予无意义（如不够一次模型调用），视为拒授排队，缺省 0 */
  minGrantUsd?: number;
}

export interface MarketGrant {
  id: string;
  bidder: string;
  askedUsd: number;
  grantedUsd: number;
  status: 'granted' | 'partial' | 'pending';
  weight: number;
  waitedRounds: number;
  state: 'open' | 'settled' | 'released';
  settledUsd?: number;
  createdAt: number;
}

let grantSeq = 0;

export class ResourceMarket {
  private capacityUsd: number;
  private aging: number;
  private grants = new Map<string, MarketGrant>();

  constructor(capacityUsd: number, aging = 1) {
    this.capacityUsd = capacityUsd;
    this.aging = aging;
  }

  /** 已结算的实际消耗 */
  spent(): number {
    let sum = 0;
    for (const g of this.grants.values()) if (g.state === 'settled') sum += g.settledUsd ?? 0;
    return sum;
  }

  /** 未结算的锁定额度（含 pending 排队者按 0 计） */
  reserved(): number {
    let sum = 0;
    for (const g of this.grants.values()) if (g.state === 'open') sum += g.grantedUsd;
    return sum;
  }

  /** 剩余可用（钳 0：超支一次后不再放行） */
  available(): number {
    return Math.max(0, this.capacityUsd - this.spent() - this.reserved());
  }

  /**
   * 竞标：队列空且容量足够 → 立即授予（配给退化路径，与 reserve 同语义）；
   * 否则入队（不急于部分授予——把分配决策留给 clear() 的加权出清，
   * 否则先到者会即时吃光容量，权重永远无法介入）。
   */
  bid(b: MarketBid, now = Date.now()): MarketGrant {
    const grant = this.enqueue(b, now);
    const queuedOthers = [...this.grants.values()].some(
      (g) => g !== grant && g.state === 'open' && g.grantedUsd < g.askedUsd,
    );
    if (!queuedOthers && b.amountUsd <= this.available()) {
      grant.grantedUsd = b.amountUsd;
      grant.status = 'granted';
    }
    return grant;
  }

  /** 无条件入队（批量竞价用：全部入队后一次 clear 出清） */
  enqueue(b: MarketBid, now = Date.now()): MarketGrant {
    const grant: MarketGrant = {
      id: `mkt-${(++grantSeq).toString(36)}`,
      bidder: b.bidder,
      askedUsd: b.amountUsd,
      grantedUsd: 0,
      status: 'pending',
      weight: b.weight ?? 1,
      waitedRounds: 0,
      state: 'open',
      createdAt: now,
    };
    this.grants.set(grant.id, grant);
    return grant;
  }

  /**
   * 拍卖出清：按有效权重（weight + waitedRounds × aging）降序、FIFO 平局，
   * 依序授予剩余容量；尾部容量不足者获部分授予（≥ minGrant 才授），
   * 其余继续排队（等待结算释放容量 + aging 逐步抬升优先级）。
   */
  clear(minGrantUsd = 0): MarketGrant[] {
    const queue = [...this.grants.values()]
      .filter((g) => g.state === 'open' && g.grantedUsd < g.askedUsd)
      .sort((a, b) => {
        const ea = a.weight + a.waitedRounds * this.aging;
        const eb = b.weight + b.waitedRounds * this.aging;
        return eb - ea || a.createdAt - b.createdAt;
      });

    let remaining = this.available();
    const changed: MarketGrant[] = [];
    for (const g of queue) {
      if (remaining <= 0) {
        g.waitedRounds++;
        continue;
      }
      const want = g.askedUsd - g.grantedUsd;
      const give = Math.min(want, remaining);
      if (give >= Math.min(minGrantUsd, g.askedUsd)) {
        g.grantedUsd += give;
        remaining -= give;
        g.status = g.grantedUsd >= g.askedUsd ? 'granted' : 'partial';
        changed.push(g);
      } else {
        g.waitedRounds++;
      }
    }
    return changed;
  }

  /** 结算：按实际成本入账，授予额度随之释放 */
  settle(id: string, actualUsd: number, now = Date.now()): MarketGrant | undefined {
    const g = this.grants.get(id);
    if (!g || g.state !== 'open' || g.grantedUsd <= 0) return undefined;
    g.state = 'settled';
    g.settledUsd = actualUsd;
    g.status = 'granted';
    return g;
  }

  /** 释放：未消耗的授予全额归还容量 */
  release(id: string): MarketGrant | undefined {
    const g = this.grants.get(id);
    if (!g || g.state !== 'open') return undefined;
    g.state = 'released';
    return g;
  }

  /** 立即出清（结算/释放释放容量后调用，让排队者上位） */
  resettle(minGrantUsd = 0): MarketGrant[] {
    return this.clear(minGrantUsd);
  }

  snapshot(): {
    capacityUsd: number;
    spentUsd: number;
    reservedUsd: number;
    availableUsd: number;
    pending: number;
    grants: MarketGrant[];
  } {
    return {
      capacityUsd: this.capacityUsd,
      spentUsd: this.spent(),
      reservedUsd: this.reserved(),
      availableUsd: this.available(),
      pending: [...this.grants.values()].filter((g) => g.state === 'open' && g.grantedUsd < g.askedUsd).length,
      grants: [...this.grants.values()],
    };
  }
}
