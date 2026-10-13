/**
 * 成本计算引擎
 *
 * 模型费率表来源（按 2026-10 当前 DeepSeek 公开定价）：
 *   - https://api-docs.deepseek.com/quick_start/pricing
 *
 * 峰谷时段（按官方文档，UTC）：
 *   - 谷段（0.25x）：UTC 16:30-00:30
 *   - 峰段（1.0x） ：其余
 *
 * 这是 CordisHub 默认的"诚实"实现——开发者可以传入自己的费率表覆盖。
 */

export interface ModelRate {
  /** 模型名（与 API 返回一致） */
  model: string;
  /** prompt 价格 USD / 1M tokens */
  promptPerMillion: number;
  /** completion 价格 USD / 1M tokens */
  completionPerMillion: number;
  /** reasoning 价格 USD / 1M tokens（如无则为 completion 价） */
  reasoningPerMillion?: number;
  /** cache read 价格 USD / 1M tokens */
  cacheReadPerMillion?: number;
  /** cache write 价格 USD / 1M tokens */
  cacheWritePerMillion?: number;
}

/** DeepSeek 默认费率表（2026-10） */
export const DEEPSEEK_RATES: ModelRate[] = [
  {
    model: 'deepseek-v4-pro',
    promptPerMillion: 0.27,
    completionPerMillion: 1.1,
    reasoningPerMillion: 1.1,
    cacheReadPerMillion: 0.07,
  },
  {
    model: 'deepseek-v4-flash',
    promptPerMillion: 0.07,
    completionPerMillion: 0.28,
    reasoningPerMillion: 0.28,
    cacheReadPerMillion: 0.018,
  },
  {
    model: 'deepseek-flash',
    promptPerMillion: 0.07,
    completionPerMillion: 0.28,
    cacheReadPerMillion: 0.018,
  },
  // Anthropic 兼容（部分 dsh 配置）
  {
    model: 'claude-3.7-sonnet',
    promptPerMillion: 3.0,
    completionPerMillion: 15.0,
  },
];

export interface CostInput {
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** 时间戳（毫秒），用于峰谷判定 */
  ts: number;
}

export interface CostOutput {
  prompt: number;
  completion: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** 是否落在谷段 */
  valley: boolean;
  total: number;
}

/** 谷段（UTC 16:30 - 次日 00:30）——官方默认窗口的代码形态 */
export function isValley(ts: number): boolean {
  const d = new Date(ts);
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const minutesOfDay = hour * 60 + minute;
  // 16:30 = 990 min, 24:30 = 1470 min (次日)
  return minutesOfDay >= 990 || minutesOfDay <= 30;
}

/**
 * 峰谷窗口（数据形态）——费率 DSL 的组成部分。
 * endUtcMinutes < startUtcMinutes 表示跨午夜窗口。
 */
export interface ValleyWindow {
  startUtcMinutes: number;
  endUtcMinutes: number;
  /** 命中窗口的价格系数（如谷段 0.25） */
  factor: number;
}

/** 命中任一窗口则返回其系数（跨午夜正确处理），否则 1.0 */
export function windowFactorAt(ts: number, windows: ValleyWindow[]): number {
  const d = new Date(ts);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  for (const w of windows) {
    const hit =
      w.startUtcMinutes <= w.endUtcMinutes
        ? m >= w.startUtcMinutes && m <= w.endUtcMinutes
        : m >= w.startUtcMinutes || m <= w.endUtcMinutes;
    if (hit) return w.factor;
  }
  return 1.0;
}

/** 默认用 DeepSeek 费率表，可以注入自定义 */
export class CostEngine {
  private rates: Map<string, ModelRate>;
  private valleyWindows?: ValleyWindow[];

  constructor(rates: ModelRate[] = DEEPSEEK_RATES) {
    this.rates = new Map(rates.map((r) => [r.model, r]));
  }

  /** 注册或覆盖一个模型费率 */
  setRate(rate: ModelRate): void {
    this.rates.set(rate.model, rate);
  }

  /** 查一个模型的费率（预授权额度估算等场景） */
  rateFor(model: string): ModelRate | undefined {
    return this.rates.get(model);
  }

  /**
   * 峰谷窗口数据化（费率 DSL）：设置后按窗口计算折扣系数；
   * 未设置则沿用官方默认（UTC 16:30-00:30 谷段 0.25x）。
   */
  setValleyWindows(windows?: ValleyWindow[]): void {
    this.valleyWindows = windows;
  }

  /** 当前折扣系数：1.0 = 峰段原价 */
  private valleyFactorAt(ts: number): number {
    if (this.valleyWindows) return windowFactorAt(ts, this.valleyWindows);
    return isValley(ts) ? 0.25 : 1.0;
  }

  /** 计算单次调用的成本 */
  compute(input: CostInput): CostOutput {
    const rate = this.rates.get(input.model);
    if (!rate) {
      // 未知模型，按 prompt=1, completion=3 兜底
      return {
        prompt: (input.promptTokens / 1e6) * 1,
        completion: (input.completionTokens / 1e6) * 3,
        reasoning: ((input.reasoningTokens ?? 0) / 1e6) * 3,
        cacheRead: ((input.cacheReadTokens ?? 0) / 1e6) * 0,
        cacheWrite: ((input.cacheWriteTokens ?? 0) / 1e6) * 0,
        valley: this.valleyFactorAt(input.ts) < 1.0,
        total:
          (input.promptTokens / 1e6) * 1 +
          (input.completionTokens / 1e6) * 3 +
          ((input.reasoningTokens ?? 0) / 1e6) * 3,
      };
    }

    const valleyFactor = this.valleyFactorAt(input.ts);
    const valley = valleyFactor < 1.0;

    const prompt = (input.promptTokens / 1e6) * rate.promptPerMillion * valleyFactor;
    const completion =
      (input.completionTokens / 1e6) * rate.completionPerMillion * valleyFactor;
    const reasoning =
      ((input.reasoningTokens ?? 0) / 1e6) *
      (rate.reasoningPerMillion ?? rate.completionPerMillion) *
      valleyFactor;
    const cacheRead =
      ((input.cacheReadTokens ?? 0) / 1e6) *
      (rate.cacheReadPerMillion ?? 0) *
      valleyFactor;
    const cacheWrite =
      ((input.cacheWriteTokens ?? 0) / 1e6) *
      (rate.cacheWritePerMillion ?? rate.promptPerMillion) *
      valleyFactor;

    return {
      prompt,
      completion,
      reasoning,
      cacheRead,
      cacheWrite,
      valley,
      total: prompt + completion + reasoning + cacheRead + cacheWrite,
    };
  }

  /** 推荐 cheapest valid 模型（同等级下挑最便宜的） */
  cheapest(rank: 'pro' | 'flash' = 'flash'): ModelRate | undefined {
    const candidates = [...this.rates.values()].filter((r) => {
      if (rank === 'pro') return /pro|sonnet|gpt-4/i.test(r.model);
      return /flash|mini|haiku/i.test(r.model);
    });
    candidates.sort((a, b) => a.completionPerMillion - b.completionPerMillion);
    return candidates[0];
  }
}