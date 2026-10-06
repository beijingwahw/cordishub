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

/** 谷段（UTC 16:30 - 次日 00:30） */
export function isValley(ts: number): boolean {
  const d = new Date(ts);
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const minutesOfDay = hour * 60 + minute;
  // 16:30 = 990 min, 24:30 = 1470 min (次日)
  return minutesOfDay >= 990 || minutesOfDay <= 30;
}

/** 默认用 DeepSeek 费率表，可以注入自定义 */
export class CostEngine {
  private rates: Map<string, ModelRate>;

  constructor(rates: ModelRate[] = DEEPSEEK_RATES) {
    this.rates = new Map(rates.map((r) => [r.model, r]));
  }

  /** 注册或覆盖一个模型费率 */
  setRate(rate: ModelRate): void {
    this.rates.set(rate.model, rate);
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
        valley: isValley(input.ts),
        total:
          (input.promptTokens / 1e6) * 1 +
          (input.completionTokens / 1e6) * 3 +
          ((input.reasoningTokens ?? 0) / 1e6) * 3,
      };
    }

    const valley = isValley(input.ts);
    const valleyFactor = valley ? 0.25 : 1.0;

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