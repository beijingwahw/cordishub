/**
 * 费率 DSL —— 费率表是"带生效日期的版本化数据"，不是代码。
 *
 * 动机（用户故事 C）：2026-08 DeepSeek 涨价那次，费率变更是代码变更，
 * 历史账单一旦重算就失真。TariffSchedule 让每个费率档带 effectiveFrom，
 * 任意时间戳的成本自动路由到当时生效的费率 + 峰谷窗口。
 */
import { CostEngine, DEEPSEEK_RATES, type CostInput, type CostOutput } from './cost.ts';
import type { ValleyWindow } from './cost.ts';

export interface Tariff {
  /** 生效时间（ISO 8601，含）；早于首档的时间戳按首档计算 */
  effectiveFrom: string;
  rates: import('./cost.ts').ModelRate[];
  /** 峰谷窗口（数据化；缺省 = 不折扣） */
  valleyWindows?: ValleyWindow[];
}

/** 当前默认费率档：与 CostEngine 内置行为完全一致的数据化表达 */
export const DEFAULT_TARIFF: Tariff = {
  effectiveFrom: '2026-01-01',
  rates: DEEPSEEK_RATES,
  valleyWindows: [{ startUtcMinutes: 990, endUtcMinutes: 30, factor: 0.25 }],
};

/**
 * 多档费率表：按时间戳路由到生效档。
 * 历史账单重算 = 用当时的 ts 调 compute()，天然精确。
 */
export class TariffSchedule {
  private tariffs: Tariff[];
  private engines = new Map<string, CostEngine>();

  constructor(tariffs: Tariff[]) {
    if (tariffs.length === 0) throw new Error('TariffSchedule requires at least one tariff');
    this.tariffs = [...tariffs].sort(
      (a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom),
    );
  }

  /** ts 时刻生效的费率档（effectiveFrom <= ts 的最后一档） */
  active(ts: number): Tariff {
    let chosen = this.tariffs[0]!;
    for (const tariff of this.tariffs) {
      if (Date.parse(tariff.effectiveFrom) <= ts) chosen = tariff;
    }
    return chosen;
  }

  /** 计算一次调用的成本 —— 自动使用 ts 当时生效的费率与峰谷窗口 */
  compute(input: CostInput): CostOutput {
    const tariff = this.active(input.ts);
    let engine = this.engines.get(tariff.effectiveFrom);
    if (!engine) {
      engine = new CostEngine(tariff.rates);
      engine.setValleyWindows(tariff.valleyWindows ?? []);
      this.engines.set(tariff.effectiveFrom, engine);
    }
    return engine.compute(input);
  }
}
