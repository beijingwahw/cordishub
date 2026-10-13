/**
 * 进化反应堆（Genesis G1）—— 变体跑批 + 适应度选择。
 *
 * 三项已有投资的汇流点：
 *   - G0 基因库：变异算子提供结构化扰动（不是随机改字符串）
 *   - L1 Cassette：盒带提供上下文确定的评估环境（工具响应可重放）
 *   - L2 BudgetLedger：燃料闸门——每个变体跑批前 reserve，预算不足直接拒绝。
 *     这是"进化不会失控"的根本保证：搜索空间再大，燃料总量封顶。
 *
 * 得失取舍（如实记录）：单批评跑不包含世代选择/繁殖循环（那是 G1.5）；
 * 适应度缺省为"先保真后省钱"，真实任务必须注入自己的 fitness。
 */
import type { Storage } from './storage.ts';
import { mutate, hashGenome, saveGenome, type AgentGenome, type GenomeMutation } from './genome.ts';
import {
  playCounterfactual,
  type CassetteTape,
  type CounterfactualModel,
  type CounterfactualResult,
} from './cassette.ts';
import { BudgetLedger, BudgetExceededError } from './budget.ts';
import { CostEngine } from './cost.ts';
import { ResourceMarket, type MarketGrant } from './market.ts';

export interface ReactorVariant {
  name: string;
  mutations: GenomeMutation[];
  /** 显式亲本（世代进化时每个变体可来自不同精英）；缺省 = seed */
  base?: AgentGenome;
}

export type ReactorFitness = (run: {
  genome: AgentGenome;
  result: CounterfactualResult | null;
  costUsd: number;
  tokens: number;
}) => number;

export type ReactorCostOf = (genome: AgentGenome, result: CounterfactualResult) => {
  costUsd: number;
  tokens: number;
};

export interface ReactorRun {
  variant: string;
  genome: AgentGenome;
  genomeHash: string;
  result: CounterfactualResult | null;
  costUsd: number;
  tokens: number;
  fitness: number;
  rejected: boolean;
  /** 拒绝原因：'budget'（配给制超额）| 'market'（竞价落选） */
  rejectedReason?: 'budget' | 'market';
}

export interface ReactorReport {
  runs: ReactorRun[];
  best: ReactorRun | null;
  spentUsd: number;
  availableUsd: number;
  budgetExhausted: boolean;
}

/** 缺省成本估算用的共享费率引擎 */
const SHARED_COST_ENGINE = new CostEngine();

/**
 * 缺省成本估算：按基因的模型费率 × 步数启发式（prompt ≈ 400/步，completion ≈ 128/步）。
 * 真实 harness 应注入按实际 token 上报的 costOf。
 */
export function defaultCostOf(genome: AgentGenome, result: CounterfactualResult): { costUsd: number; tokens: number } {
  const rate = SHARED_COST_ENGINE.rateFor(genome.model);
  const promptTokens = 400 * (1 + result.steps.length);
  const completionTokens = 128 * result.steps.length;
  const p = rate ? rate.promptPerMillion : 1;
  const c = rate ? rate.completionPerMillion : 3;
  return { tokens: promptTokens + completionTokens, costUsd: (promptTokens * p + completionTokens * c) / 1e6 };
}

/** 缺省适应度：先保真（不与录制轨迹分叉）后省钱 */
export function defaultFitness(run: {
  genome: AgentGenome;
  result: CounterfactualResult | null;
  costUsd: number;
  tokens: number;
}): number {
  if (!run.result) return -Infinity;
  const faithful = run.result.divergedAtStep === null;
  return (faithful ? 1 : 0) - run.costUsd;
}

/**
 * 变体跑批：对每个变体（seed + 依序变异）——
 *   燃料预授权（预算不足 → 拒绝，标记 budgetExhausted）
 *   → 盒带重放（注入 harness 作为该变体的"模型"）
 *   → 按实际成本结算燃料 → 计算适应度
 * 最后选出适应度最高的变体（拒绝的变体不参与评选）。
 */
export function runReactor(opts: {
  seed: AgentGenome;
  variants: ReactorVariant[];
  tape: CassetteTape;
  harness: (genome: AgentGenome) => CounterfactualModel;
  /** 配给制燃料闸门（与 fuel 二选一） */
  budget?: BudgetLedger;
  /**
   * G3 市场模式：世代级批量竞价（与 budget 二选一）。
   * 容量足够时逐字退化为配给制；争抢出现才启动加权拍卖——
   * 维度激活纪律的运行时实现，见 docs/DESIGN.md。
   */
  fuel?: {
    capacityUsd: number;
    /** 出价权重（谱系适应度 / 任务优先级），缺省 1 */
    weightOf?: (variant: ReactorVariant, genome: AgentGenome) => number;
    minGrantUsd?: number;
  };
  fitness?: ReactorFitness;
  costOf?: ReactorCostOf;
  /** 每个变体的燃料预授权额度（美元） */
  fuelPerRunUsd?: number;
  maxSteps?: number;
  fromSeq?: number;
  /** 提供则把每个变体存入 KV 基因库（谱系自动指向亲本） */
  storage?: Storage;
  /** 被燃料拒绝的变体是否入库（缺省 true：视为"已探索"素材） */
  saveRejected?: boolean;
}): ReactorReport {
  if (!opts.budget && !opts.fuel) {
    throw new Error('fuel gate required: pass budget (rationing) or fuel (market)');
  }
  const fitness = opts.fitness ?? defaultFitness;
  const costOf = opts.costOf ?? defaultCostOf;
  const fuel = opts.fuelPerRunUsd ?? 0.05;
  const runs: ReactorRun[] = [];
  let budgetExhausted = false;

  // 种子入库（谱系根节点；与某变体同指纹时自然去重）
  if (opts.storage) saveGenome(opts.storage, opts.seed);

  // 预构建全部变体基因（市场模式需要先出价、一次出清、再依序执行）
  const built = opts.variants.map((v) => {
    let genome = v.base ?? opts.seed;
    for (const m of v.mutations) genome = mutate(genome, m);
    return { v, genome, genomeHash: hashGenome(genome) };
  });

  const market = opts.fuel ? new ResourceMarket(opts.fuel.capacityUsd) : undefined;
  const grants: Array<MarketGrant | undefined> = market
    ? built.map(({ v, genome }, i) =>
        market.enqueue(
          {
            bidder: `reactor:${v.name}`,
            amountUsd: fuel,
            weight: opts.fuel!.weightOf?.(v, genome) ?? 1,
            minGrantUsd: opts.fuel!.minGrantUsd,
          },
          Date.now() + i, // FIFO 平局顺序稳定
        ),
      )
    : [];
  // 一次加权出清：容量足够时全部立即等额授予（= 配给制）；争抢才见权重
  if (market) market.clear(opts.fuel!.minGrantUsd ?? 0);

  for (let i = 0; i < built.length; i++) {
    const { v, genome, genomeHash } = built[i]!;

    // 燃料闸门：配给制 = 逐个预授权；市场制 = 竞价结果（granted 0 = 落选）
    let reserveId: string | undefined;
    let rejected = false;
    let rejectedReason: 'budget' | 'market' | undefined;
    if (market) {
      const g = grants[i]!;
      if (g.grantedUsd <= 0) {
        rejected = true;
        rejectedReason = 'market';
        budgetExhausted = true;
      } else {
        reserveId = g.id;
      }
    } else {
      try {
        reserveId = opts.budget!.reserve(fuel, `reactor:${v.name}`);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetExhausted = true;
          rejected = true;
          rejectedReason = 'budget';
        } else {
          throw err;
        }
      }
    }

    if (rejected) {
      if (opts.storage && opts.saveRejected !== false) saveGenome(opts.storage, genome);
      runs.push({
        variant: v.name,
        genome,
        genomeHash,
        result: null,
        costUsd: 0,
        tokens: 0,
        fitness: -Infinity,
        rejected: true,
        rejectedReason,
      });
      continue;
    }
    if (opts.storage) saveGenome(opts.storage, genome);

    // 市场部分授予的变体照跑（授予额即本变体燃料上限，实际成本由结算记账）
    const result = playCounterfactualSafe(opts, market ?? opts.budget!, genome, reserveId!);
    const { costUsd, tokens } = costOf(genome, result);
    if (market) market.settle(reserveId!, costUsd);
    else opts.budget!.settle(reserveId!, costUsd);
    runs.push({
      variant: v.name,
      genome,
      genomeHash,
      result,
      costUsd,
      tokens,
      fitness: fitness({ genome, result, costUsd, tokens }),
      rejected: false,
    });
  }

  let best: ReactorRun | null = null;
  for (const r of runs) {
    if (!r.rejected && (best === null || r.fitness > best.fitness)) best = r;
  }
  return {
    runs,
    best,
    spentUsd: market ? market.spent() : opts.budget!.spent(),
    availableUsd: market ? market.available() : opts.budget!.available(),
    budgetExhausted,
  };
}

/**
 * 盒带重放（带燃料保护）：harness 抛异常时预授权必须释放，
 * 否则该批次的燃料被永久锁死——闸门不能因为实验失败而失效。
 */
function playCounterfactualSafe(
  opts: {
    tape: CassetteTape;
    harness: (genome: AgentGenome) => CounterfactualModel;
    maxSteps?: number;
    fromSeq?: number;
  },
  gate: { release(id: string): unknown },
  genome: AgentGenome,
  reserveId: string,
): CounterfactualResult {
  try {
    return playCounterfactual(opts.tape, {
      model: opts.harness(genome),
      maxSteps: opts.maxSteps,
      fromSeq: opts.fromSeq,
    });
  } catch (err) {
    gate.release(reserveId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 世代进化（G1.5）：选择 → 变异 → 下一代，燃料跨世代共享
// ---------------------------------------------------------------------------

/** 种子化 RNG（mulberry32）：缺省进化即复现——同一 seed 跑出同一搜索轨迹 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 选择策略 DSL：多世代选择的可插拔算子
// ---------------------------------------------------------------------------

export type SelectionStrategy =
  /** 截断精英：取适应度 top-N（最简单，易早熟收敛） */
  | { kind: 'truncation'; eliteSize: number }
  /** 锦标赛：每轮随机抽 size 个参赛者取最优，共 winners 轮 */
  | { kind: 'tournament'; size: number; winners: number }
  /** 轮盘赌：适应度加权随机采样（保持选择压的同时保留低分个体的小概率） */
  | { kind: 'roulette'; winners: number }
  /** 多样性保护：贪心取 top，但跳过与已选亲本过近的个体——防早熟收敛的关键算子 */
  | { kind: 'diversity'; eliteSize: number; minDistance: number };

/** 基因组特征袋（model + tools + policy + prompt 指纹） */
function featureBag(g: AgentGenome): Set<string> {
  return new Set([
    `model:${g.model}`,
    ...g.tools.map((t) => `tool:${t}`),
    `policy:${JSON.stringify(g.policy)}`,
    `prompt:${g.systemPrompt.length}:${g.systemPrompt.slice(0, 32)}`,
  ]);
}

/** 基因组距离 = 1 - Jaccard(featureBag(a), featureBag(b))；0 = 特征全同 */
export function genomeDistance(a: AgentGenome, b: AgentGenome): number {
  const fa = featureBag(a);
  const fb = featureBag(b);
  let inter = 0;
  for (const x of fa) if (fb.has(x)) inter++;
  const union = fa.size + fb.size - inter;
  return union === 0 ? 0 : 1 - inter / union;
}

/** 按策略从本代 run 中选出下一代亲本（只考虑未拒绝且适应度有限的个体） */
export function selectParents(
  runs: ReactorRun[],
  strategy: SelectionStrategy,
  rng: () => number = Math.random,
): AgentGenome[] {
  const viable = runs
    .filter((r) => !r.rejected && Number.isFinite(r.fitness))
    .sort((a, b) => b.fitness - a.fitness);

  switch (strategy.kind) {
    case 'truncation':
      return viable.slice(0, strategy.eliteSize).map((r) => r.genome);

    case 'tournament': {
      const winners: AgentGenome[] = [];
      const seen = new Set<string>();
      for (let w = 0; w < strategy.winners && viable.length > 0; w++) {
        let best = viable[Math.floor(rng() * viable.length)]!;
        for (let i = 1; i < strategy.size; i++) {
          const cand = viable[Math.floor(rng() * viable.length)]!;
          if (cand.fitness > best.fitness) best = cand;
        }
        const hash = hashGenome(best.genome);
        if (!seen.has(hash)) {
          seen.add(hash);
          winners.push(best.genome);
        }
      }
      return winners;
    }

    case 'roulette': {
      if (viable.length === 0) return [];
      const min = viable[viable.length - 1]!.fitness;
      const weights = viable.map((r) => r.fitness - min + 1e-9);
      const total = weights.reduce((s, w) => s + w, 0);
      const winners: AgentGenome[] = [];
      const seen = new Set<string>();
      for (let w = 0; w < strategy.winners && total > 0; w++) {
        let pick = rng() * total;
        for (let i = 0; i < viable.length; i++) {
          pick -= weights[i]!;
          if (pick <= 0) {
            const hash = hashGenome(viable[i]!.genome);
            if (!seen.has(hash)) {
              seen.add(hash);
              winners.push(viable[i]!.genome);
            }
            break;
          }
        }
      }
      return winners;
    }

    case 'diversity': {
      const picked: AgentGenome[] = [];
      for (const r of viable) {
        if (picked.length >= strategy.eliteSize) break;
        const farEnough = picked.every((g) => genomeDistance(r.genome, g) >= strategy.minDistance);
        if (farEnough) picked.push(r.genome);
      }
      // 兜底：全太相似时退化为截断首位，保证亲本非空
      if (picked.length === 0 && viable.length > 0) picked.push(viable[0]!.genome);
      return picked;
    }
  }
}

export interface EvolutionReport {
  generations: Array<{ index: number; parentHashes: string[]; report: ReactorReport }>;
  /** 跨世代名人堂（按适应度排序前的全部已完成 run） */
  hallOfFame: ReactorRun[];
  best: ReactorRun | null;
  spentUsd: number;
  budgetExhausted: boolean;
}

/**
 * 世代进化：每代从上一代精英（top eliteSize）中选亲本，从变异池随机取一个
 * 算子生成种群，跑批 → 排序 → 精英成为下一代亲本。燃料账本跨世代共享——
 * 总预算就是进化的总闸门。缺省 rng = seededRng(42)：进化实验可复现。
 */
export function evolve(opts: {
  seed: AgentGenome;
  generations: number;
  populationSize: number;
  mutationPool: GenomeMutation[];
  tape: CassetteTape;
  harness: (genome: AgentGenome) => CounterfactualModel;
  /** 配给制总闸门（与 fuel 二选一）：跨世代共享 */
  budget?: BudgetLedger;
  /** G3 市场模式（与 budget 二选一）：每世代一个燃料池，批量竞价出清 */
  fuel?: {
    perGenerationUsd: number;
    weightOf?: (variant: ReactorVariant, genome: AgentGenome) => number;
    minGrantUsd?: number;
  };
  fitness?: ReactorFitness;
  costOf?: ReactorCostOf;
  fuelPerRunUsd?: number;
  maxSteps?: number;
  fromSeq?: number;
  storage?: Storage;
  saveRejected?: boolean;
  rng?: () => number;
  /** 每世代精英数（成为下一代亲本），缺省 2；提供 selection 时被忽略 */
  eliteSize?: number;
  /** 选择策略 DSL（缺省 = 截断精英 eliteSize） */
  selection?: SelectionStrategy;
}): EvolutionReport {
  const rng = opts.rng ?? seededRng(42);
  const selection: SelectionStrategy =
    opts.selection ?? { kind: 'truncation', eliteSize: opts.eliteSize ?? 2 };
  const generations: EvolutionReport['generations'] = [];
  const hallOfFame: ReactorRun[] = [];
  let parents: AgentGenome[] = [opts.seed];
  let budgetExhausted = false;
  let marketSpent = 0;

  for (let gen = 0; gen < opts.generations; gen++) {
    const variants: ReactorVariant[] = [];
    for (let i = 0; i < opts.populationSize; i++) {
      const parent = parents[i % parents.length]!;
      const mutation = opts.mutationPool[Math.floor(rng() * opts.mutationPool.length)]!;
      variants.push({ name: `g${gen}-v${i}`, base: parent, mutations: [mutation] });
    }

    const report = runReactor({
      seed: opts.seed,
      variants,
      tape: opts.tape,
      harness: opts.harness,
      budget: opts.budget,
      fuel: opts.fuel
        ? { capacityUsd: opts.fuel.perGenerationUsd, weightOf: opts.fuel.weightOf, minGrantUsd: opts.fuel.minGrantUsd }
        : undefined,
      fitness: opts.fitness,
      costOf: opts.costOf,
      fuelPerRunUsd: opts.fuelPerRunUsd,
      maxSteps: opts.maxSteps,
      fromSeq: opts.fromSeq,
      storage: opts.storage,
      saveRejected: opts.saveRejected,
    });
    if (opts.fuel && !opts.budget) marketSpent += report.spentUsd;
    generations.push({ index: gen, parentHashes: parents.map((p) => hashGenome(p)), report });
    budgetExhausted = budgetExhausted || report.budgetExhausted;

    const ranked = report.runs.filter((r) => !r.rejected).sort((a, b) => b.fitness - a.fitness);
    hallOfFame.push(...ranked);
    if (ranked.length === 0) break; // 燃料耗尽，进化自然终止
    parents = selectParents(report.runs, selection, rng);
    if (parents.length === 0) parents = [opts.seed];
  }

  let best: ReactorRun | null = null;
  for (const r of hallOfFame) {
    if (best === null || r.fitness > best.fitness) best = r;
  }
  return {
    generations,
    hallOfFame,
    best,
    spentUsd: opts.budget ? opts.budget.spent() : marketSpent,
    budgetExhausted,
  };
}
