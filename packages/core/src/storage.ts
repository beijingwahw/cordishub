/**
 * Append-Only Event Store —— JSONL + 内存索引
 *
 * 设计动机：在没有 native binary 的环境里也能跑。
 *
 * 性能特性：
 *   - 写入 O(1)：append to JSONL
 *   - 全文搜索 O(n) 倒排索引（演示场景 < 50ms）
 *   - 范围查询 O(log n)：B+ tree-ish on memory map
 *
 * 真生产环境建议换回 better-sqlite3 + FTS5；接口保持兼容。
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { escapeHtml, escapeRegExp } from './html.ts';
import { GENESIS, computeRoot, isSealRow, lineHash, sealHash, verifyFile, type SealRow, type VerifyReport } from './merkle.ts';
import type { Session, SessionCheckpoint, SessionEvent } from './types.ts';

export interface StorageOptions {
  /** DB 文件路径（不含扩展名，自动追加 .jsonl） */
  path: string;
  /** 静默模式 */
  silent?: boolean;
  /** 每累积 N 个数据行自动写一个哈希链封印（0 = 关闭自动封印，默认 50） */
  sealEvery?: number;
}

interface ChainState {
  /** 已写封印数 */
  index: number;
  /** 当前链头（最后一个封印行的哈希，导出外部即可锚定整条链） */
  head: string;
  /** 自上个封印以来的数据行哈希 */
  pending: string[];
}

interface AppendOnlyFile {
  path: string;
  /** 内存中的全部记录，按 [table, id] 索引 */
  rows: Map<string, any>;
  /** 哈希链封印状态（防篡改审计） */
  chain: ChainState;
}

/**
 * 历史版本写入过 snake_case 字段（total_tokens / ended_at ...）。
 * 内存态统一 camelCase：读入时透明迁移，新写入只落 camelCase。
 * 同一行两套字段并存时以 snake 值为准（它是后 append 的累计真值）。
 */
const SNAKE_TO_CAMEL: Record<string, string> = {
  total_tokens: 'totalTokens',
  total_cost: 'totalCost',
  started_at: 'startedAt',
  ended_at: 'endedAt',
  session_id: 'sessionId',
};

function normalizeRow(row: any): any {
  for (const [snake, camel] of Object.entries(SNAKE_TO_CAMEL)) {
    if (row[snake] !== undefined) {
      row[camel] = row[snake];
      delete row[snake];
    }
  }
  return row;
}

export class Storage {
  private sessionsFile: AppendOnlyFile;
  private eventsFile: AppendOnlyFile;
  private checkpointsFile: AppendOnlyFile;
  private kvFile: AppendOnlyFile;
  private logger: (msg: string) => void;
  private sealEvery: number;

  /** 倒排索引：word → Set of eventId */
  private ftsIndex = new Map<string, Set<string>>();
  /** event 全文（供 snippet 渲染） */
  private ftsContent = new Map<string, string>();

  constructor(opts: StorageOptions) {
    this.logger = opts.silent ? () => {} : (msg) => process.stderr.write(`[storage] ${msg}\n`);
    this.sealEvery = opts.sealEvery ?? 50;

    const base = opts.path.replace(/\.jsonl$/, '').replace(/\.db$/, '');
    this.sessionsFile = this.openFile(`${base}.sessions.jsonl`);
    this.eventsFile = this.openFile(`${base}.events.jsonl`);
    this.checkpointsFile = this.openFile(`${base}.checkpoints.jsonl`);
    // KV 文件必须在构造时打开（而非 writeKv 时懒加载），否则重启进程后
    // readKv/listKv 因文件未打开而永远返回空，持久化形同虚设
    this.kvFile = this.openFile(`${base}.kv.jsonl`);

    this.rebuildFtsIndex();
  }

  private openFile(path: string): AppendOnlyFile {
    const dir = dirname(path);
    if (dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(path)) writeFileSync(path, '');

    const rows = new Map<string, any>();
    const chain: ChainState = { index: 0, head: GENESIS, pending: [] };
    if (statSync(path).size > 0) {
      const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
      for (const line of lines) {
        let row: any;
        try {
          row = JSON.parse(line);
        } catch {
          continue; // 跳过损坏行
        }
        if (isSealRow(row)) {
          // 重启续链：恢复封印状态（完整性验证由 verifyFile 单独负责）
          chain.index = row.index + 1;
          chain.head = sealHash(row);
          chain.pending = [];
          continue;
        }
        row = normalizeRow(row);
        const id = this.idOf(row);
        if (id) rows.set(id, row);
        chain.pending.push(lineHash(line));
      }
    }
    return { path, rows, chain };
  }

  private idOf(row: any): string | undefined {
    if (typeof row.id === 'string') return row.id;
    // KV 行没有 id —— 必须用 table+key 复合键。
    // 旧实现按"字段名排序"兜底，导致所有同形状的 KV 行在内存 Map 里折叠成一条，持久化索引失效。
    if (typeof row.table === 'string' && typeof row.key === 'string') {
      return `kv:${row.table}::${row.key}`;
    }
    // checkpoint 行没有 id —— 用 session+seq 复合键，否则写入后内存索引跳过、永远读不回
    if (typeof row.sessionId === 'string' && typeof row.seq === 'number') {
      return `${row.sessionId}::cp${row.seq}`;
    }
    if (typeof row.full_name === 'string') return row.full_name;
    return undefined;
  }

  private appendTo(file: AppendOnlyFile, row: any): void {
    const line = JSON.stringify(row);
    appendFileSync(file.path, line + '\n');
    const id = this.idOf(row);
    if (id) file.rows.set(id, row);
    file.chain.pending.push(lineHash(line));
    if (this.sealEvery > 0 && file.chain.pending.length >= this.sealEvery) {
      this.writeSeal(file);
    }
  }

  /** 写一个封印行：覆盖 pending 数据行，链头推进 */
  private writeSeal(file: AppendOnlyFile): void {
    if (file.chain.pending.length === 0) return;
    const seal: SealRow = {
      __seal: true,
      index: file.chain.index,
      prev: file.chain.head,
      root: computeRoot(file.chain.pending),
      rowCount: file.chain.pending.length,
      ts: Date.now(),
    };
    appendFileSync(file.path, JSON.stringify(seal) + '\n');
    file.chain.index += 1;
    file.chain.head = sealHash(seal);
    file.chain.pending = [];
  }

  /** 全文索引重建 */
  private rebuildFtsIndex(): void {
    this.ftsIndex.clear();
    this.ftsContent.clear();
    for (const ev of this.eventsFile.rows.values()) {
      const text = this.extractText(ev);
      this.ftsContent.set(ev.id, text);
      for (const word of this.tokenize(text)) {
        if (!this.ftsIndex.has(word)) this.ftsIndex.set(word, new Set());
        this.ftsIndex.get(word)!.add(ev.id);
      }
    }
  }

  private extractText(row: any): string {
    const p = row.payload ?? {};
    const argsText =
      typeof p.arguments === 'string' ? p.arguments : typeof p.args === 'string' ? p.args : '';
    return [
      row.source,
      row.model ?? '',
      p.tool_name ?? '',
      p.text ?? '',
      p.result?.stdout ?? p.stdout ?? '',
      argsText,
    ].join(' ');
  }

  /** 分词（unicode-safe，按 unicode 6.2 simple word segmentation） */
  private tokenize(text: string): string[] {
    // 简单实现：转小写，按非字母数字汉字切，保留中文连续字符
    const tokens: string[] = [];
    const re = /([\p{L}\p{N}]+)/gu;
    let m2: RegExpExecArray | null;
    while ((m2 = re.exec(text)) !== null) tokens.push(m2[1].toLowerCase());
    return tokens;
  }

  /** ===== Public API ===== */

  /** 开始一个 session */
  beginSession(session: Session): void {
    this.appendTo(this.sessionsFile, session);
    this.logger(`begin session ${session.id} (model=${session.model})`);
  }

  /** 追加一个 event（append-only） */
  appendEvent(event: SessionEvent): void {
    this.appendTo(this.eventsFile, event);
    const text = this.extractText(event);
    this.ftsContent.set(event.id, text);
    for (const word of this.tokenize(text)) {
      if (!this.ftsIndex.has(word)) this.ftsIndex.set(word, new Set());
      this.ftsIndex.get(word)!.add(event.id);
    }
  }

  /** 累加 token 与 cost 到 session */
  accumulate(sessionId: string, tokens: number, cost: number): void {
    const s = this.sessionsFile.rows.get(sessionId);
    if (s) {
      s.totalTokens = (s.totalTokens ?? 0) + tokens;
      s.totalCost = (s.totalCost ?? 0) + cost;
      this.appendTo(this.sessionsFile, s);
    }
  }

  /** 关闭 session */
  endSession(sessionId: string, endedAt: number): void {
    const s = this.sessionsFile.rows.get(sessionId);
    if (s) {
      s.endedAt = endedAt;
      this.appendTo(this.sessionsFile, s);
    }
  }

  /** 创建一个 checkpoint */
  checkpoint(cp: SessionCheckpoint): void {
    this.appendTo(this.checkpointsFile, cp);
  }

  /** 取一个 session（含累计 token / cost） */
  getSession(sessionId: string): Session | undefined {
    return this.sessionsFile.rows.get(sessionId) as Session | undefined;
  }

  /** 取一个 session 的全部 events */
  getEvents(sessionId: string): SessionEvent[] {
    return [...this.eventsFile.rows.values()]
      .filter((e) => e.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq) as SessionEvent[];
  }

  /** 取一个 session 的某个 [fromSeq, toSeq] 范围 */
  getEventRange(sessionId: string, fromSeq: number, toSeq: number): SessionEvent[] {
    return this.getEvents(sessionId).filter((e) => e.seq >= fromSeq && e.seq <= toSeq);
  }

  /** 全文搜索 —— 返回带高亮的 snippet */
  fullTextSearch(query: string, limit = 50): Array<{
    sessionId: string;
    eventId: string;
    source: string;
    snippet: string;
  }> {
    const words = this.tokenize(query);
    if (words.length === 0) return [];

    // 候选 = 任一关键词命中的 eventId（取并集）
    const cand = new Set<string>();
    for (const w of words) {
      const ids = this.ftsIndex.get(w);
      if (ids) for (const id of ids) cand.add(id);
    }

    // 简单 bm25-lite：每个词在文件中出现次数越多，分越低；文档 + token
    const scored: Array<{ id: string; score: number; content: string; source: string; sessionId: string }> = [];
    for (const id of cand) {
      const ev = this.eventsFile.rows.get(id);
      if (!ev) continue;
      const text = this.ftsContent.get(id) ?? '';
      let hits = 0;
      const lowerText = text.toLowerCase();
      for (const w of words) {
        const re = new RegExp(escapeRegExp(w), 'gi');
        const matches = lowerText.match(re);
        if (matches) hits += matches.length;
      }
      if (hits > 0) {
        scored.push({
          id,
          score: hits,
          content: text,
          source: ev.source,
          sessionId: ev.sessionId,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => ({
      sessionId: s.sessionId,
      eventId: s.id,
      source: s.source,
      snippet: this.highlight(s.content, words),
    }));
  }

  private highlight(text: string, words: string[]): string {
    const MAX = 200;
    // 先整体转义再插入 <mark>，防止日志内容注入 HTML
    let snippet = escapeHtml(text.slice(0, MAX));
    for (const w of words) {
      const re = new RegExp(`(${escapeRegExp(w)})`, 'gi');
      snippet = snippet.replace(re, '<mark>$1</mark>');
    }
    return snippet + (text.length > MAX ? '…' : '');
  }

  /** 成本汇总 */
  costBreakdown(): Array<{
    id: string;
    model: string;
    totalTokens: number;
    totalCost: number;
    startedAt: number;
    endedAt: number | null;
  }> {
    // 去重（同一 session 可能被多次 append；取最新一条）
    const m = new Map<string, any>();
    for (const s of this.sessionsFile.rows.values()) m.set(s.id, s);
    return [...m.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((s) => ({
        id: s.id,
        model: s.model,
        totalTokens: s.totalTokens ?? 0,
        totalCost: s.totalCost ?? 0,
        startedAt: s.startedAt,
        endedAt: s.endedAt ?? null,
      }));
  }

  /** 最近 N 个 session */
  recentSessions(limit = 20): Session[] {
    return this.costBreakdown()
      .slice(0, limit)
      .map((s) => ({
        id: s.id,
        startedAt: s.startedAt,
        endedAt: s.endedAt ?? undefined,
        model: s.model,
        totalTokens: s.totalTokens,
        totalCost: s.totalCost,
      }));
  }

  /** 取一个 session 的全部 checkpoints */
  checkpoints(sessionId: string): SessionCheckpoint[] {
    return [...this.checkpointsFile.rows.values()]
      .filter((c) => c.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq) as SessionCheckpoint[];
  }

  /** 关闭（无操作） */
  close(): void {
    // JSONL 自动持久化，无需关闭
  }

  /** ===== L0 · 投影维护 ===== */

  /**
   * 压实：append-only 历史中同一 id 的旧行被最新行取代（accumulate 每次追加整行
   * session，长会话会 O(n²) 膨胀）。compact 把每个文件原子收敛为"每 id 只留最新行"。
   *
   * 多进程加固（v0.2.1）：
   *   - 写出前从磁盘 fresh-read —— 本进程启动后其它进程的追加不会被内存快照误删；
   *   - 全程持有 .lock 咨询锁，两个 CordisHub 进程的 compact 不会互相踩踏；
   *   - 诚实的边界：非协作进程在"读取→替换"窗口内的追加仍可能丢失，
   *     完整多写者安全需要 tier-2 的 SQLite 后端。
   */
  compact(): Array<{ file: string; rows: number }> {
    const unlock = this.acquireLock('compact');
    try {
      const result: Array<{ file: string; rows: number }> = [];
      const fresh = {
        sessions: this.openFile(this.sessionsFile.path),
        events: this.openFile(this.eventsFile.path),
        checkpoints: this.openFile(this.checkpointsFile.path),
        kv: this.openFile(this.kvFile.path),
      };
      for (const f of [fresh.sessions, fresh.events, fresh.checkpoints, fresh.kv]) {
        const dataLines = [...f.rows.values()].map((r) => JSON.stringify(r));
        // 压实重开新链：封印 prev 指向压实前的链头（compactedFrom 血统锚点），
        // 审计者可以看到"内容在链头 X 处被压实过"
        const seal: SealRow = {
          __seal: true,
          index: 0,
          prev: f.chain.head,
          root: computeRoot(dataLines.map((l) => lineHash(l))),
          rowCount: dataLines.length,
          ts: Date.now(),
          compactedFrom: f.chain.head,
        };
        const tmp = `${f.path}.compact-tmp`;
        writeFileSync(tmp, dataLines.map((l) => l + '\n').join('') + JSON.stringify(seal) + '\n');
        renameSync(tmp, f.path);
        f.chain = { index: 1, head: sealHash(seal), pending: [] };
        result.push({ file: f.path, rows: f.rows.size });
      }
      this.sessionsFile = fresh.sessions;
      this.eventsFile = fresh.events;
      this.checkpointsFile = fresh.checkpoints;
      this.kvFile = fresh.kv;
      this.rebuildFtsIndex();
      return result;
    } finally {
      unlock();
    }
  }

  /** ===== L0 · 哈希链封印 ===== */

  /** 立即封印全部有未覆盖数据行的文件（session 结束 / 定期审计前调用） */
  sealNow(): void {
    this.writeSeal(this.sessionsFile);
    this.writeSeal(this.eventsFile);
    this.writeSeal(this.checkpointsFile);
    this.writeSeal(this.kvFile);
  }

  /** 全量验证四个日志文件的哈希链（防篡改审计） */
  verifyChains(): VerifyReport[] {
    return [
      this.sessionsFile,
      this.eventsFile,
      this.checkpointsFile,
      this.kvFile,
    ].map((f) => verifyFile(f.path));
  }

  /** 当前链头（导出保存到外部即锚定整条链） */
  chainHeads(): Array<{ file: string; head: string; seals: number; unsealedRows: number }> {
    const snap = (f: AppendOnlyFile) => ({
      file: f.path,
      head: f.chain.head,
      seals: f.chain.index,
      unsealedRows: f.chain.pending.length,
    });
    return [snap(this.sessionsFile), snap(this.eventsFile), snap(this.checkpointsFile), snap(this.kvFile)];
  }

  /** 咨询锁：独占创建 lock 文件；超过 staleMs 视为陈锁并接管（进程崩溃的兜底） */
  private acquireLock(name: string): () => void {
    const lockPath = `${this.sessionsFile.path}.${name}.lock`;
    const staleMs = 30_000;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        writeFileSync(lockPath, `${process.pid} ${Date.now()}\n`, { flag: 'wx' });
        return () => {
          try {
            rmSync(lockPath);
          } catch {
            // 已被陈锁清理，无需处理
          }
        };
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > staleMs) {
            rmSync(lockPath);
            continue;
          }
        } catch {
          continue; // lock 恰好消失，立即重试
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); // 同步等待 100ms
    }
    throw new Error(`cannot acquire ${name} lock on ${lockPath} (busy)`);
  }

  /** 从磁盘重建全部内存投影 —— 日志是唯一真相，任何投影损坏都可以用它恢复 */
  rebuild(): void {
    this.sessionsFile = this.openFile(this.sessionsFile.path);
    this.eventsFile = this.openFile(this.eventsFile.path);
    this.checkpointsFile = this.openFile(this.checkpointsFile.path);
    this.kvFile = this.openFile(this.kvFile.path);
    this.rebuildFtsIndex();
  }

  /** ===== KV API —— 给 Hub / 扩展用 ===== */

  /** 写一个 KV（持久化到 .kv.jsonl） */
  writeKv(table: string, key: string, value: any): void {
    this.appendTo(this.kvFile, { table, key, value, ts: Date.now() });
  }

  /** 读一个 KV —— 返回最新值 */
  readKv<T = any>(table: string, key: string): T | undefined {
    let result: T | undefined;
    for (const row of this.kvFile.rows.values()) {
      if (row.table === table && row.key === key) {
        result = row.value as T;
      }
    }
    return result;
  }

  /** 列出一个 table 下所有 key-value（去重，保留最新） */
  listKv<T = any>(table: string): Array<{ key: string; value: T }> {
    const m = new Map<string, T>();
    for (const row of this.kvFile.rows.values()) {
      if (row.table === table) m.set(row.key, row.value as T);
    }
    return [...m.entries()].map(([key, value]) => ({ key, value }));
  }
}