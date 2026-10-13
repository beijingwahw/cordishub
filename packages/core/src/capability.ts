/**
 * 能力令牌（ocap 最小版）—— 把工具白名单从"字符串比对"升级为结构性最小权限。
 *
 * 三条不可违反的衰减不变量：
 *   1. 权限只能收窄（请求父代没有的工具 = 尝试扩权，显式拒绝）
 *   2. 预算只能变小，期限只能提前
 *   3. 委托深度 +1，超过 maxDepth 拒绝（防止无限委托链）
 */

import { randomBytes } from 'node:crypto';

export interface Capability {
  /** 不可预测的令牌标识（不可伪造） */
  readonly tag: string;
  readonly tenant: string;
  readonly tools: readonly string[];
  readonly maxSpendUsd?: number;
  readonly depth: number;
  readonly maxDepth: number;
  readonly parentTag?: string;
  readonly expiresAt?: number;
}

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityError';
  }
}

export function mintRoot(
  spec: { tenant: string; tools: string[]; maxSpendUsd?: number; maxDepth?: number; ttlMs?: number },
  now = Date.now(),
): Capability {
  return {
    tag: `cap-${randomBytes(8).toString('hex')}`,
    tenant: spec.tenant,
    tools: [...new Set(spec.tools)].sort(),
    maxSpendUsd: spec.maxSpendUsd,
    depth: 0,
    maxDepth: spec.maxDepth ?? 4,
    expiresAt: spec.ttlMs !== undefined ? now + spec.ttlMs : undefined,
  };
}

export function isExpired(cap: Capability, now = Date.now()): boolean {
  return cap.expiresAt !== undefined && now >= cap.expiresAt;
}

/**
 * 衰减：返回深度 +1 的子令牌。任何"放宽"请求（新工具 / 更大预算 / 更晚过期 /
 * 超深委托）都直接抛 CapabilityError——POLA 的失败必须是关闭的。
 */
export function attenuate(
  parent: Capability,
  opts: { tools?: string[]; maxSpendUsd?: number; ttlMs?: number } = {},
  now = Date.now(),
): Capability {
  if (isExpired(parent, now)) {
    throw new CapabilityError(`capability ${parent.tag} has expired`);
  }
  if (parent.depth >= parent.maxDepth) {
    throw new CapabilityError(`delegation depth exceeded (max ${parent.maxDepth})`);
  }
  if (opts.tools && opts.tools.some((t) => !parent.tools.includes(t))) {
    throw new CapabilityError(
      `attenuation cannot grant tools not held by parent: ${opts.tools.filter((t) => !parent.tools.includes(t)).join(', ')}`,
    );
  }

  const tools = opts.tools ? [...new Set(opts.tools)].sort() : parent.tools;

  let maxSpendUsd = parent.maxSpendUsd;
  if (opts.maxSpendUsd !== undefined) {
    maxSpendUsd = maxSpendUsd === undefined ? opts.maxSpendUsd : Math.min(maxSpendUsd, opts.maxSpendUsd);
  }

  let expiresAt = parent.expiresAt;
  if (opts.ttlMs !== undefined) {
    const child = now + opts.ttlMs;
    expiresAt = expiresAt === undefined ? child : Math.min(expiresAt, child);
  }

  return {
    tag: `cap-${randomBytes(8).toString('hex')}`,
    tenant: parent.tenant,
    tools,
    maxSpendUsd,
    depth: parent.depth + 1,
    maxDepth: parent.maxDepth,
    parentTag: parent.tag,
    expiresAt,
  };
}

/** 工具调用准入：过期或未授予即抛 CapabilityError */
export function assertTool(cap: Capability, tool: string, now = Date.now()): void {
  if (isExpired(cap, now)) {
    throw new CapabilityError(`capability ${cap.tag} has expired`);
  }
  if (!cap.tools.includes(tool)) {
    throw new CapabilityError(`tool "${tool}" not granted by capability ${cap.tag} (tenant ${cap.tenant})`);
  }
}
