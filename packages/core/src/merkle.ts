/**
 * Merkle 哈希链封印 —— 防篡改审计（L0 硬化）。
 *
 * 模型：数据行每累积 K 条（或显式 sealNow()）写一个封印行：
 *   { __seal: true, index, prev, root, rowCount, ts }
 *     root = 自上个封印以来所有数据行哈希的链式折叠
 *     prev = 上一个封印行的哈希（封印自身成链）
 *
 * verifyFile() 全量重放：数据行 root 失配 = 数据被篡改；prev 链断裂 = 封印被篡改。
 *
 * 诚实边界（必须写清楚）：链不能阻止"重写整条链"的攻击者——但重写会改变链头
 * head。把 head 导出保存到外部（打印 / 备份 / 时间戳服务）即获得完全强度。
 * compact() 重开新链时以 compactedFrom 记录旧链头作为血统锚点。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** 创世值（空链的头） */
export const GENESIS = '0'.repeat(64);

export interface SealRow {
  __seal: true;
  index: number;
  /** 上一个封印的哈希（首个封印可为血统锚点，如 compactedFrom） */
  prev: string;
  /** 自上个封印以来数据行哈希的折叠根 */
  root: string;
  rowCount: number;
  ts: number;
  /** 压实重开新链时，压实前的链头 */
  compactedFrom?: string;
}

export interface VerifyReport {
  file: string;
  ok: boolean;
  seals: number;
  rows: number;
  head: string;
  error?: string;
}

export function isSealRow(row: unknown): row is SealRow {
  return typeof row === 'object' && row !== null && (row as Record<string, unknown>)['__seal'] === true;
}

export function lineHash(line: string): string {
  return createHash('sha256').update(line).digest('hex');
}

/** 封印行自身的哈希 = 链头推进值 */
export function sealHash(seal: SealRow): string {
  return lineHash(JSON.stringify(seal));
}

/** 一批数据行哈希 → merkle 折叠根（链式累积，空批次 = GENESIS） */
export function computeRoot(hashes: string[]): string {
  return hashes.reduce(
    (acc, h) => createHash('sha256').update(acc + h).digest('hex'),
    GENESIS,
  );
}

/** 全量重放验证一个封印日志文件 */
export function verifyFile(path: string): VerifyReport {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return { file: path, ok: false, seals: 0, rows: 0, head: GENESIS, error: 'file unreadable' };
  }

  const lines = content.split('\n').filter((l) => l.trim());
  let prev = GENESIS;
  let pending: string[] = [];
  let seals = 0;
  let rows = 0;
  let first = true;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { file: path, ok: false, seals, rows, head: prev, error: `corrupt line #${rows + seals + 1}` };
    }
    if (isSealRow(parsed)) {
      if (parsed.root !== computeRoot(pending)) {
        return { file: path, ok: false, seals, rows, head: prev, error: `seal #${parsed.index} root mismatch（数据行被篡改）` };
      }
      // 首个封印的 prev 是血统锚点（创世 GENESIS 或 compactedFrom），无法在文件内验证
      if (!first && parsed.prev !== prev) {
        return { file: path, ok: false, seals, rows, head: prev, error: `seal #${parsed.index} chain broken（封印被篡改）` };
      }
      first = false;
      prev = sealHash(parsed);
      pending = [];
      seals++;
    } else {
      pending.push(lineHash(line));
      rows++;
    }
  }
  return { file: path, ok: true, seals, rows, head: prev };
}
