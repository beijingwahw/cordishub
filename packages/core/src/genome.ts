/**
 * 基因维度（Genesis G0）—— 会话的可遗传化。
 *
 * 核心洞察：事件日志里已经藏着进化所需的全部原料——
 *   - 遗传物质 = 会话的声明式部分（system prompt / 模型 / 工具集 / 子代理拓扑 / 策略）
 *   - 变异 = 对这份 manifest 的结构化扰动（不是随机改字符串）
 *   - 适应度 = 已有的成本 fold（见 fitnessOf）
 * 日志是表型，AgentGenome 是基因型；繁殖 = fork + manifest overlay。
 */
import { createHash } from 'node:crypto';
import type { Storage } from './storage.ts';
import type { ReplayEngine } from './replay.ts';

export interface SubagentSpec {
  name: string;
  prompt: string;
  tools: string[];
}

/** 智能体基因型：可遗传的声明式配置 */
export interface AgentGenome {
  name: string;
  version: string;
  /** 谱系：父代基因组指纹（及可选的来源 session） */
  parent?: { genomeHash: string; sessionId?: string };
  systemPrompt: string;
  model: string;
  tools: string[];
  subagents: SubagentSpec[];
  policy: {
    maxTokens?: number;
    maxCostUsd?: number;
    maxSubagents?: number;
    memoryGate?: boolean;
    memoryGateThreshold?: number;
  };
  tags?: string[];
}

/** 结构化变异算子（纯函数，父代不可变） */
export type GenomeMutation =
  | { kind: 'prompt-append'; text: string }
  | { kind: 'prompt-replace'; text: string }
  | { kind: 'model-swap'; model: string }
  | { kind: 'tool-add'; tools: string[] }
  | { kind: 'tool-remove'; tools: string[] }
  | { kind: 'policy'; patch: AgentGenome['policy'] };

export interface GenomeFitness {
  sessions: number;
  totalTokens: number;
  totalCost: number;
  avgCostPerSession: number;
}

/** 稳定序列化：集合类字段排序，保证同内容 → 同指纹 */
export function canonicalGenome(g: AgentGenome): string {
  return JSON.stringify({
    name: g.name,
    version: g.version,
    parent: g.parent,
    systemPrompt: g.systemPrompt,
    model: g.model,
    tools: [...g.tools].sort(),
    subagents: [...g.subagents].map((s) => ({ ...s, tools: [...s.tools].sort() })).sort((a, b) => a.name.localeCompare(b.name)),
    policy: g.policy,
    tags: [...(g.tags ?? [])].sort(),
  });
}

/** 基因组指纹（sha256 hex） */
export function hashGenome(g: AgentGenome): string {
  return createHash('sha256').update(canonicalGenome(g)).digest('hex');
}

/** 从已记录的 session 提取基因型（日志 → 基因型的投影） */
export function extractGenomeFromSession(
  sessionId: string,
  storage: Storage,
  replay: ReplayEngine,
  opts: { name?: string; version?: string } = {},
): AgentGenome | undefined {
  const session = storage.getSession(sessionId);
  if (!session) return undefined;
  const state = replay.reconstruct(sessionId);

  const subagentNames = new Set<string>();
  for (const ev of state.history) {
    if (ev.source === 'subagent') {
      const name = (ev.payload as any)?.name ?? ev.subagentId;
      if (typeof name === 'string' && name) subagentNames.add(name);
    }
  }

  return {
    name: opts.name ?? `genome/${sessionId}`,
    version: opts.version ?? '0.1.0',
    parent: undefined,
    systemPrompt: state.systemPrompt.trim(),
    model: session.model,
    tools: [...new Set(state.toolCalls.map((t) => t.name))].sort(),
    subagents: [...subagentNames].sort().map((name) => ({ name, prompt: '', tools: [] })),
    policy: {},
    tags: ['extracted'],
  };
}

function bumpPatch(version: string): string {
  const parts = version.split('.');
  const last = Number.parseInt(parts[parts.length - 1] ?? '0', 10);
  if (!Number.isFinite(last)) return `${version}.1`;
  parts[parts.length - 1] = String(last + 1);
  return parts.join('.');
}

/** 变异：纯函数——返回携带谱系与版本 bump 的子代，父代不被修改 */
export function mutate(parent: AgentGenome, mutation: GenomeMutation, opts: { version?: string } = {}): AgentGenome {
  const child = structuredClone(parent);
  child.parent = { genomeHash: hashGenome(parent) };
  child.version = opts.version ?? bumpPatch(parent.version);

  switch (mutation.kind) {
    case 'prompt-append':
      child.systemPrompt = `${child.systemPrompt}\n${mutation.text}`.trim();
      break;
    case 'prompt-replace':
      child.systemPrompt = mutation.text;
      break;
    case 'model-swap':
      child.model = mutation.model;
      break;
    case 'tool-add':
      child.tools = [...new Set([...child.tools, ...mutation.tools])].sort();
      break;
    case 'tool-remove':
      child.tools = child.tools.filter((t) => !mutation.tools.includes(t));
      break;
    case 'policy':
      child.policy = { ...child.policy, ...mutation.patch };
      break;
  }

  child.tags = [...new Set([...(parent.tags ?? []), 'mutant'])];
  return child;
}

/** 持久化到 KV 表 'genome'（键 = 基因组指纹），返回指纹 */
export function saveGenome(storage: Storage, g: AgentGenome): string {
  const hash = hashGenome(g);
  storage.writeKv('genome', hash, g);
  return hash;
}

/** 加载全部已持久化的基因组 */
export function loadGenomes(storage: Storage): Array<{ hash: string; genome: AgentGenome }> {
  return storage.listKv<AgentGenome>('genome').map((x) => ({ hash: x.key, genome: x.value }));
}

function genomeHashOf(session: { meta?: Record<string, unknown> }): string | undefined {
  const g = session.meta?.['genome'] as { hash?: string } | undefined;
  return typeof g?.hash === 'string' ? g.hash : undefined;
}

/**
 * 谱系适应度：聚合所有携带该基因标记的 session 的成本 fold。
 * 这是"进化的评分系统"——不需要新账本，复用已有投影。
 */
export function fitnessOf(storage: Storage, genomeHash: string): GenomeFitness {
  let sessions = 0;
  let totalTokens = 0;
  let totalCost = 0;
  for (const b of storage.costBreakdown()) {
    const full = storage.getSession(b.id);
    if (full && genomeHashOf(full) === genomeHash) {
      sessions++;
      totalTokens += b.totalTokens;
      totalCost += b.totalCost;
    }
  }
  return { sessions, totalTokens, totalCost, avgCostPerSession: sessions > 0 ? totalCost / sessions : 0 };
}

/** 人类可读的基因组摘要（CLI / demo） */
export function renderGenome(g: AgentGenome): string[] {
  const promptPreview = g.systemPrompt.slice(0, 60).replace(/\n/g, ' ');
  return [
    `${g.name}  v${g.version}  [${hashGenome(g).slice(0, 12)}]`,
    `  parent:    ${g.parent ? `${g.parent.genomeHash.slice(0, 12)}${g.parent.sessionId ? ` (from ${g.parent.sessionId})` : ''}` : '（原始提取）'}`,
    `  model:     ${g.model}`,
    `  prompt:    ${promptPreview}${g.systemPrompt.length > 60 ? '…' : ''}`,
    `  tools:     ${g.tools.join(', ') || '（无）'}`,
    `  subagents: ${g.subagents.length}`,
    `  policy:    ${JSON.stringify(g.policy)}`,
    `  tags:      ${(g.tags ?? []).join(', ')}`,
  ];
}
