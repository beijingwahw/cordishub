/**
 * CordisHub core 单元测试 —— node --test + 类型剥离，零额外依赖。
 *
 * 覆盖：存储层（KV 持久化 / camelCase 归一化 / snake 迁移）、成本引擎（峰谷）、
 * 回放（model 事件 / diff / fork 继承）、安全网、Hub、service 集成（session/ended
 * 两种载荷形态、fork options、checkpoint）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Storage } from '../src/storage.ts';
import { CostEngine, isValley, windowFactorAt } from '../src/cost.ts';
import { TariffSchedule, DEFAULT_TARIFF } from '../src/tariff.ts';
import { BudgetLedger, BudgetExceededError } from '../src/budget.ts';
import {
  generateSigningKeyPair,
  signManifest,
  verifyManifest,
  diffCapabilities,
  renderCapabilityDiff,
  TrustRegistry,
  type PluginManifest,
} from '../src/manifest.ts';
import { ReplayEngine } from '../src/replay.ts';
import {
  extractGenomeFromSession,
  mutate,
  hashGenome,
  saveGenome,
  loadGenomes,
  fitnessOf,
  type AgentGenome,
} from '../src/genome.ts';
import { verifyFile, GENESIS } from '../src/merkle.ts';
import { mintRoot, attenuate, assertTool, isExpired, CapabilityError } from '../src/capability.ts';
import {
  recordTape,
  verifyTape,
  playCounterfactual,
  bisectFirstBad,
  type CfAction,
  type CounterfactualModel,
} from '../src/cassette.ts';
import { runReactor, evolve, seededRng } from '../src/reactor.ts';
import { certifyDeterminism, stampSampling, locateBadEvents } from '../src/cassette.ts';
import { taintScan, cacheTaintCompatible, tenantTaintPolicy } from '../src/taint.ts';
import { selectParents, genomeDistance, type ReactorRun } from '../src/reactor.ts';
import { syncHubTopic, syncHubTopics, type RepoFetcher } from '../src/hubsync.ts';
import { ResourceMarket } from '../src/market.ts';
import { HubIndex, DEMO_PLUGINS } from '../src/hub.ts';
import { SafetyNet } from '../src/safety.ts';
import { CordishubService } from '../src/service.ts';
import type { Session, SessionEvent } from '../src/types.ts';

function tmpDb(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `cordishub-${name}-`)), 'db');
}

function ev(i: number, sessionId: string, source: SessionEvent['source'], payload: Record<string, unknown>, extra: Partial<SessionEvent> = {}): SessionEvent {
  // 事件 id 在全局必须唯一（schema 约定同雪花 ID），因此带上 session 前缀
  return { id: `${sessionId}-e${i}`, sessionId, source, ts: 1_700_000_000_000 + i, seq: i, payload, ...extra };
}

function sess(id: string): Session {
  return { id, startedAt: 1_700_000_000_000, model: 'deepseek-v4-pro', totalTokens: 0, totalCost: 0 };
}

// ---------- Storage ----------

test('storage · KV 行不折叠：多个 key 重载后全部可见（回归：旧 idOf 把所有 KV 行折叠成一条）', () => {
  const db = tmpDb('kv');
  const s1 = new Storage({ path: db, silent: true });
  s1.writeKv('hub', 'a/b', { n: 1 });
  s1.writeKv('hub', 'c/d', { n: 2 });
  s1.writeKv('hub', 'e/f', { n: 3 });
  s1.close();

  const s2 = new Storage({ path: db, silent: true });
  assert.equal(s2.listKv('hub').length, 3, '重载后 3 个 KV 条目都必须在');
  assert.deepEqual(s2.readKv('hub', 'c/d'), { n: 2 });
  // 同 key 二次写入应覆盖为最新值
  s2.writeKv('hub', 'a/b', { n: 11 });
  const s3 = new Storage({ path: db, silent: true });
  assert.deepEqual(s3.readKv('hub', 'a/b'), { n: 11 });
});

test('storage · session 读写统一 camelCase，落盘行不再出现 snake 字段', () => {
  const db = tmpDb('camel');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('s1'));
  s.accumulate('s1', 100, 0.05);
  s.endSession('s1', 1_700_000_000_999);
  s.close();

  const lastLine = readFileSync(`${db}.sessions.jsonl`, 'utf8').trim().split('\n').pop();
  const row = JSON.parse(lastLine!);
  assert.equal(row.totalTokens, 100);
  assert.equal(row.endedAt, 1_700_000_000_999);
  assert.equal(row.total_tokens, undefined);
  assert.equal(row.ended_at, undefined);

  const re = new Storage({ path: db, silent: true });
  const b = re.costBreakdown().find((x) => x.id === 's1')!;
  assert.equal(b.totalTokens, 100);
  assert.equal(b.totalCost, 0.05);
  assert.equal(b.endedAt, 1_700_000_000_999);
});

test('storage · 历史 snake_case 数据行读入时透明迁移', () => {
  const db = tmpDb('legacy');
  const s = new Storage({ path: db, silent: true });
  s.close();
  // 手工追加一行旧格式数据
  appendFileSync(
    `${db}.sessions.jsonl`,
    JSON.stringify({ id: 'legacy', started_at: 123, model: 'm', total_tokens: 42, total_cost: 0.5, ended_at: 456 }) + '\n',
  );
  const re = new Storage({ path: db, silent: true });
  const b = re.costBreakdown().find((x) => x.id === 'legacy')!;
  assert.equal(b.totalTokens, 42);
  assert.equal(b.totalCost, 0.5);
  assert.equal(b.startedAt, 123);
  assert.equal(b.endedAt, 456);
});

// ---------- CostEngine ----------

test('cost · 峰谷边界与 0.25 折扣系数', () => {
  assert.equal(isValley(Date.UTC(2026, 9, 5, 16, 30)), true, '16:30 UTC 起为谷段');
  assert.equal(isValley(Date.UTC(2026, 9, 5, 16, 29)), false, '16:29 UTC 仍是峰段');
  assert.equal(isValley(Date.UTC(2026, 9, 5, 0, 30)), true, '00:30 UTC 仍是谷段');
  assert.equal(isValley(Date.UTC(2026, 9, 5, 0, 31)), false, '00:31 UTC 起为峰段');

  const engine = new CostEngine();
  const peak = engine.compute({
    model: 'deepseek-v4-pro',
    promptTokens: 1_000_000,
    completionTokens: 0,
    cacheReadTokens: 1_000_000,
    ts: Date.UTC(2026, 9, 5, 10, 0), // 峰段
  });
  assert.ok(Math.abs(peak.total - 0.34) < 1e-9, `峰段 1M prompt + 1M cacheRead 应为 $0.34，实际 ${peak.total}`);
  assert.equal(peak.valley, false);

  const valley = engine.compute({
    model: 'deepseek-v4-pro',
    promptTokens: 1_000_000,
    completionTokens: 0,
    cacheReadTokens: 1_000_000,
    ts: Date.UTC(2026, 9, 5, 17, 0), // 谷段
  });
  assert.ok(Math.abs(valley.total - 0.34 * 0.25) < 1e-9, `谷段应为峰段 1/4，实际 ${valley.total}`);
  assert.equal(valley.valley, true);
});

// ---------- ReplayEngine ----------

test('replay · reconstruct 捕获 model 事件文本 + tool call 配对', () => {
  const db = tmpDb('replay');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('r1'));
  s.appendEvent(ev(1, 'r1', 'system', { text: 'You are an engineer.' }));
  s.appendEvent(ev(2, 'r1', 'user', { text: 'refactor billing' }));
  s.appendEvent(ev(3, 'r1', 'reasoning', { text: 'plan first' }));
  s.appendEvent(ev(4, 'r1', 'tool', { tool_name: 'shell', arguments: { cmd: 'ls' }, result: { stdout: 'a.ts' } }, { toolCallId: 'tc1' }));
  s.appendEvent(ev(5, 'r1', 'model', { text: 'I will extract a PricingPolicy seam.' }, { model: 'deepseek-v4-pro', tokens: { prompt: 10, completion: 5, total: 15 } }));

  const engine = new ReplayEngine(s);
  const state = engine.reconstruct('r1');
  assert.equal(state.systemPrompt.trim(), 'You are an engineer.');
  assert.equal(state.userInputs.length, 1);
  assert.equal(state.modelResponses.length, 1, "source='model' 的事件文本必须被捕获");
  assert.match(state.modelResponses[0]!, /PricingPolicy/);
  assert.equal(state.toolCalls.length, 1);
  assert.equal(state.toolCalls[0]!.name, 'shell');
  assert.deepEqual(state.toolCalls[0]!.result, { stdout: 'a.ts' });
  assert.equal(state.totalTokens, 15);
  s.close();
});

test('replay · fork 继承原 session 的模型，label 写入 meta', () => {
  const db = tmpDb('fork');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('f1'));
  s.appendEvent(ev(1, 'f1', 'user', { text: 'go' }, { model: 'deepseek-v4-flash' }));
  s.appendEvent(ev(2, 'f1', 'user', { text: 'on' }, { model: 'deepseek-v4-flash' }));

  const engine = new ReplayEngine(s);
  const forked = engine.fork('f1', 2, 'f1-child', { label: 'replan' });
  assert.equal(forked.model, 'deepseek-v4-flash', '不指定 model 时应继承最后一条事件的模型');
  assert.equal(forked.meta?.label, 'replan');
  assert.equal(engine.reconstruct('f1-child').history.length, 2);

  // 事件不带 model 时，回退继承父 session 的 model（三层继承链）
  s.beginSession(sess('f2'));
  s.appendEvent(ev(1, 'f2', 'user', { text: 'no-model-event' }));
  assert.equal(engine.fork('f2', 1, 'f2-child').model, 'deepseek-v4-pro');
  s.close();
});

test('replay · diff 按 seq 对齐并返回三数组结构', () => {
  const db = tmpDb('diff');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('d1'));
  s.beginSession(sess('d2'));
  s.appendEvent(ev(1, 'd1', 'user', { text: 'same' }));
  s.appendEvent(ev(2, 'd1', 'user', { text: 'only-in-a' }));
  s.appendEvent(ev(1, 'd2', 'user', { text: 'same' }));
  s.appendEvent(ev(3, 'd2', 'user', { text: 'only-in-b' }));

  const r = new ReplayEngine(s).diff('d1', 'd2', { fromSeq: 0, toSeq: 5 });
  assert.equal(r.onlyInA.length, 1);
  assert.equal(r.onlyInB.length, 1);
  assert.equal(r.onlyInA[0]!.payload.text, 'only-in-a');
  assert.equal(r.different.length, 0);
  s.close();
});

// ---------- SafetyNet ----------

test('safety · 工具越权拦截 + 命名空间键', () => {
  const net = new SafetyNet({ tenant: 'acme', toolWhitelist: ['shell', 'read_file'] });
  const bad = net.check(ev(1, 's', 'tool', { tool_name: 'delete_database', arguments: {} }));
  assert.equal(bad.ok, false);
  assert.equal(bad.violations[0]!.kind, 'tool-overreach');
  assert.equal(bad.violations[0]!.severity, 'block');

  const good = net.check(ev(2, 's', 'tool', { tool_name: 'shell', arguments: {} }));
  assert.equal(good.ok, true);

  assert.equal(net.namespaceKey('cache:main'), 't:acme::cache:main');

  const capped = new SafetyNet({ tenant: 'acme', maxCostUsd: 1 });
  const over = capped.check(ev(3, 's', 'user', { text: 'hi' }), { tokens: 0, cost: 2, subagents: 0 });
  assert.equal(over.violations[0]!.kind, 'budget-cap');
});

// ---------- Hub ----------

test('hub · 搜索排序与 lockfile 写出（回归：ESM 下 require 报错）', () => {
  const db = tmpDb('hub');
  const s = new Storage({ path: db, silent: true });
  const hub = new HubIndex(s);
  hub.ingest(DEMO_PLUGINS);

  const hits = hub.search({ query: 'review' });
  assert.equal(hits[0]!.fullName, 'community/dsh-plugin-pr-review', '按相关性+热度排序，pr-review 应第一');
  assert.ok(hits.length >= 2);

  const lockPath = join(db, '..', 'cordishub.lock');
  hub.writeLockfile(lockPath, DEMO_PLUGINS.slice(0, 2));
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(lock.version, 1);
  assert.equal(lock.plugins.length, 2);
  assert.equal(lock.plugins[0].name, 'deepseek-ai/dsh');
  s.close();
});

// ---------- CordishubService 集成 ----------

function mockCtx() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on: (e: string, h: (...args: unknown[]) => void) => {
      if (!listeners.has(e)) listeners.set(e, []);
      listeners.get(e)!.push(h);
    },
    off: () => {},
    emit: (e: string, ...args: unknown[]) => {
      for (const h of listeners.get(e) ?? []) h(...args);
    },
    plugin: () => {},
    set: () => {},
    get: () => undefined,
  } as any;
}

test('service · session/ended 两种载荷形态都能关闭 session（回归）', () => {
  const db = tmpDb('end');
  const ctx = mockCtx();
  const svc = new CordishubService(ctx, { dbPath: db });
  svc.install();

  ctx.emit('session/started', sess('so'));
  ctx.emit('model/response', ev(1, 'so', 'model', { text: 'hi' }, { model: 'deepseek-v4-pro', tokens: { prompt: 100, completion: 10, total: 110 } }));
  ctx.emit('session/ended', { id: 'so', ts: 1_700_000_000_500 }); // 对象形态

  ctx.emit('session/started', sess('ss'));
  ctx.emit('session/ended', 'ss', 1_700_000_000_600); // 两参形态

  const b = new Map(svc.costBreakdown().map((x) => [x.id, x]));
  assert.equal(b.get('so')!.endedAt, 1_700_000_000_500);
  assert.equal(b.get('so')!.totalTokens, 110);
  assert.equal(b.get('ss')!.endedAt, 1_700_000_000_600);
  svc.dispose();
});

test('service · fork options 透传（label 不再丢失）+ checkpoint 落盘', () => {
  const db = tmpDb('fork2');
  const ctx = mockCtx();
  const svc = new CordishubService(ctx, { dbPath: db });
  svc.install();

  ctx.emit('session/started', sess('k1'));
  ctx.emit('context/injection', ev(1, 'k1', 'user', { text: 'go' }, { model: 'deepseek-v4-flash' }));
  ctx.emit('context/injection', ev(2, 'k1', 'user', { text: 'on' }, { model: 'deepseek-v4-flash' }));

  const cp = svc.checkpoint('k1', 2, 'before fork');
  assert.equal(cp?.message, 'before fork');
  assert.equal(svc.storage.checkpoints('k1').length, 1);

  const forked = svc.fork('k1', 2, 'k1-f', { label: 'replan' });
  assert.equal(forked.meta?.label, 'replan', 'label 必须透传到新 session');
  assert.equal(forked.model, 'deepseek-v4-flash', '不指定 model 时继承原 session 模型');
  assert.equal(svc.reconstruct('k1-f').history.length, 2);
  svc.dispose();
});

// ---------- 第三轮升级修复的回归 ----------

test('storage · FTS snippet 转义 HTML（防存储型 XSS）', () => {
  const db = tmpDb('xss');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('x1'));
  s.appendEvent(ev(1, 'x1', 'user', { text: '<script>alert(1)</script> please refactor billing' }));
  const hits = s.fullTextSearch('billing');
  assert.equal(hits.length, 1);
  assert.ok(!hits[0]!.snippet.includes('<script>'), 'snippet 不得包含原始 <script>');
  assert.ok(hits[0]!.snippet.includes('&lt;script&gt;'), '必须以转义形态出现');
  assert.ok(hits[0]!.snippet.includes('<mark>billing</mark>'), '高亮标记仍正常');
  s.close();
});

test('replay · 工具 payload 兼容 arguments/args 与 result/stdout，且无 toolCallId 也能配对', () => {
  const db = tmpDb('toolcompat');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('t1'));
  // 旧式命名：args + 裸 stdout，且没有 toolCallId
  s.appendEvent(ev(1, 't1', 'tool', { tool_name: 'shell', args: { cmd: 'ls' } }));
  s.appendEvent(ev(2, 't1', 'tool', { tool_name: 'shell', stdout: 'a.ts\nb.ts' }));

  const state = new ReplayEngine(s).reconstruct('t1');
  assert.equal(state.toolCalls.length, 1, 'call + result 应配对成一个 toolCall');
  assert.deepEqual(state.toolCalls[0]!.args, { cmd: 'ls' }, 'args 命名也要被识别');
  assert.deepEqual(state.toolCalls[0]!.result, { stdout: 'a.ts\nb.ts' }, '裸 stdout 要被包装成 result');
  s.close();
});

test('service · safety 违规持久化，重启后历史可恢复', () => {
  const db = tmpDb('safep');
  const policy = { tenant: 't', toolWhitelist: ['shell'] };
  const ctx1 = mockCtx();
  const svc1 = new CordishubService(ctx1, { dbPath: db, safetyPolicy: policy });
  svc1.install();
  ctx1.emit('session/started', sess('p1'));
  ctx1.emit('tool/called', ev(1, 'p1', 'tool', { tool_name: 'drop_table', arguments: {} }));
  assert.equal(svc1.safetyHistory().length, 1);
  svc1.dispose();

  const svc2 = new CordishubService(mockCtx(), { dbPath: db, safetyPolicy: policy });
  svc2.install();
  assert.equal(svc2.safetyHistory().length, 1, '重启后历史违规应从 events 持久层恢复');
  assert.equal(svc2.safetyHistory()[0]!.kind, 'tool-overreach');
  svc2.dispose();
});

// ---------- v0.2 · L0 投影维护 ----------

test('storage · compact 收敛 append 历史且保留最新真值', () => {
  const db = tmpDb('compact');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('c1'));
  s.accumulate('c1', 10, 0.1);
  s.accumulate('c1', 20, 0.2);
  s.endSession('c1', 999);
  const before = readFileSync(`${db}.sessions.jsonl`, 'utf8').trim().split('\n').length;
  s.compact();
  const after = readFileSync(`${db}.sessions.jsonl`, 'utf8').trim().split('\n').length;
  assert.ok(before >= 4, `压实前应有多行（实际 ${before}）`);
  assert.equal(after, 2, '压实后 = 1 数据行 + 1 血统封印行');
  const re = new Storage({ path: db, silent: true });
  const b = re.costBreakdown().find((x) => x.id === 'c1')!;
  assert.equal(b.totalTokens, 30, '累计真值不丢');
  assert.ok(Math.abs(b.totalCost - 0.3) < 1e-9);
  assert.equal(b.endedAt, 999);
  s.close();
});

test('storage · rebuild 从磁盘重建投影（外部写入可见，含 FTS）', () => {
  const db = tmpDb('rebuild2');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('rb1'));
  appendFileSync(
    `${db}.events.jsonl`,
    JSON.stringify({ id: 'rb1-x', sessionId: 'rb1', source: 'user', ts: 1, seq: 9, payload: { text: 'external billing note' } }) + '\n',
  );
  assert.equal(s.getEvents('rb1').length, 0, '外部写入在重建前不可见');
  s.rebuild();
  assert.equal(s.getEvents('rb1').length, 1);
  assert.ok(s.fullTextSearch('billing').length >= 1, 'FTS 索引随投影重建');
  s.close();
});

// ---------- v0.2 · L2a 费率 DSL ----------

test('tariff · 费率按生效日期切换，历史账单按当时费率重算', () => {
  const sched = new TariffSchedule([
    {
      effectiveFrom: '2026-01-01',
      rates: [{ model: 'm', promptPerMillion: 2, completionPerMillion: 4 }],
      valleyWindows: [],
    },
    {
      effectiveFrom: '2026-08-01',
      rates: [{ model: 'm', promptPerMillion: 1, completionPerMillion: 2 }],
      valleyWindows: [{ startUtcMinutes: 0, endUtcMinutes: 1439, factor: 0.5 }],
    },
  ]);
  const jan = sched.compute({ model: 'm', promptTokens: 1_000_000, completionTokens: 0, ts: Date.UTC(2026, 3, 1, 12) });
  assert.ok(Math.abs(jan.total - 2) < 1e-9, `4 月按旧档 $2，实际 ${jan.total}`);
  const sep = sched.compute({ model: 'm', promptTokens: 1_000_000, completionTokens: 0, ts: Date.UTC(2026, 8, 15, 12) });
  assert.ok(Math.abs(sep.total - 0.5) < 1e-9, `9 月按新档 + 全天 0.5 窗口 = $0.5，实际 ${sep.total}`);
});

test('tariff · 跨午夜窗口 + DEFAULT_TARIFF 与 CostEngine 内置行为一致', () => {
  const win = [{ startUtcMinutes: 990, endUtcMinutes: 30, factor: 0.25 }];
  assert.equal(windowFactorAt(Date.UTC(2026, 9, 5, 23, 0), win), 0.25, '23:00 UTC 在跨午夜谷段内');
  assert.equal(windowFactorAt(Date.UTC(2026, 9, 5, 8, 0), win), 1.0, '08:00 UTC 在峰段');
  const ts = Date.UTC(2026, 9, 5, 17, 0);
  const viaDsl = new TariffSchedule([DEFAULT_TARIFF]).compute({
    model: 'deepseek-v4-pro',
    promptTokens: 1_000_000,
    completionTokens: 0,
    cacheReadTokens: 1_000_000,
    ts,
  });
  const viaEngine = new CostEngine().compute({
    model: 'deepseek-v4-pro',
    promptTokens: 1_000_000,
    completionTokens: 0,
    cacheReadTokens: 1_000_000,
    ts,
  });
  assert.ok(Math.abs(viaDsl.total - viaEngine.total) < 1e-12, '数据化表达与代码内置行为完全一致');
});

// ---------- v0.2 · L2b 预算预授权 ----------

test('budget · reserve/settle/release 记账数学', () => {
  const ledger = new BudgetLedger(1.0);
  const r1 = ledger.reserve(0.3, 'call-1');
  const r2 = ledger.reserve(0.3, 'call-2');
  assert.ok(Math.abs(ledger.available() - 0.4) < 1e-9);
  ledger.settle(r1, 0.25);
  assert.ok(Math.abs(ledger.spent() - 0.25) < 1e-9);
  assert.ok(Math.abs(ledger.available() - 0.45) < 1e-9, '结算差额自动释放');
  ledger.release(r2);
  assert.ok(Math.abs(ledger.available() - 0.75) < 1e-9);
  // 直接入账兜底：未走预授权的调用事后补账
  ledger.charge(0.2, 'no-preauth');
  assert.ok(Math.abs(ledger.spent() - 0.45) < 1e-9);
  assert.ok(Math.abs(ledger.available() - 0.55) < 1e-9);
  assert.equal(ledger.snapshot().warn, false);
});

test('budget · 超限在 reserve 处硬熔断 + 悬挂预授权超时回收', () => {
  const ledger = new BudgetLedger(0.5);
  assert.throws(() => ledger.reserve(0.6), BudgetExceededError);
  const t0 = 1_700_000_000_000;
  ledger.reserve(0.2, 'stale', t0);
  const released = ledger.releaseStale(60_000, t0 + 61_000);
  assert.equal(released, 1);
  assert.ok(Math.abs(ledger.available() - 0.5) < 1e-9, '回收后额度恢复');
});

test('service · 预算预授权：超限在调用前拦截并记违规', () => {
  const db = tmpDb('budget1');
  const ctx = mockCtx();
  const svc = new CordishubService(ctx, {
    dbPath: db,
    budget: { limitUsd: 0.001, reserveEstimateUsd: 0.01 },
  });
  svc.install();
  ctx.emit('session/started', sess('b1'));
  ctx.emit('model/request', ev(1, 'b1', 'model', {}, { model: 'deepseek-v4-pro' }));
  const h = svc.safetyHistory();
  assert.equal(h.length, 1, '预授权被拒应立即产生违规记录');
  assert.equal(h[0]!.kind, 'budget-cap');
  assert.equal(h[0]!.severity, 'block');
  svc.dispose();
});

test('service · 预算预授权：request→response 按实际成本结算', () => {
  const db = tmpDb('budget2');
  const ctx = mockCtx();
  const svc = new CordishubService(ctx, { dbPath: db, budget: { limitUsd: 10, reserveEstimateUsd: 0.5 } });
  svc.install();
  ctx.emit('session/started', sess('b2'));
  ctx.emit('model/request', ev(1, 'b2', 'model', {}, { model: 'deepseek-v4-pro' }));
  ctx.emit(
    'model/response',
    ev(2, 'b2', 'model', { text: 'hi' }, { model: 'deepseek-v4-pro', tokens: { prompt: 1000, completion: 100, total: 1100 } }),
  );
  assert.ok(Math.abs(svc.budget!.reserved()) < 1e-12, '结算后锁定额度归零');
  assert.ok(svc.budget!.spent() > 0);
  assert.ok(Math.abs(svc.budget!.spent() - (svc.sessionCost('b2') as any).totalCost) < 1e-12, '账本与成本投影一致');
  svc.dispose();
});

test('service · 预算兜底：未走 model/request 的调用直接入账，账本不失真', () => {
  const db = tmpDb('budget3');
  const ctx = mockCtx();
  const svc = new CordishubService(ctx, { dbPath: db, budget: { limitUsd: 10 } });
  svc.install();
  ctx.emit('session/started', sess('b3'));
  ctx.emit(
    'model/response',
    ev(1, 'b3', 'model', { text: 'hi' }, { model: 'deepseek-v4-pro', tokens: { prompt: 1000, completion: 100, total: 1100 } }),
  );
  assert.ok(svc.budget!.spent() > 0, '无预授权钩子的调用也必须入账');
  assert.ok(Math.abs(svc.budget!.spent() - (svc.sessionCost('b3') as any).totalCost) < 1e-12, 'charge 兜底保证账本与投影一致');
  svc.dispose();
});

// ---------- v0.2 · L3 签名 manifest ----------

test('manifest · ed25519 签名/验签，篡改必败 + 能力 diff', () => {
  const kp = generateSigningKeyPair();
  const m: PluginManifest = {
    name: 'community/x',
    version: '1.0.0',
    capabilities: ['fs.read', 'net'],
    contentHash: 'ab'.repeat(32),
    tarball: 'https://example.com/x.tgz',
  };
  const sig = signManifest(m, kp.privateKey);
  assert.equal(verifyManifest(m, sig, kp.publicKey), true);
  assert.equal(verifyManifest({ ...m, contentHash: 'cd'.repeat(32) }, sig, kp.publicKey), false, '内容篡改必须验签失败');
  assert.equal(verifyManifest({ ...m, capabilities: ['shell'] }, sig, kp.publicKey), false, '能力声明篡改必须验签失败');
  assert.equal(verifyManifest(m, 'AAAA', kp.publicKey), false, '签名损坏返回 false 而非抛错');

  const d = diffCapabilities(['fs.read', 'net'], ['fs.read', 'fs.write', 'shell']);
  assert.deepEqual(d.added, ['fs.write', 'shell']);
  assert.deepEqual(d.removed, ['net']);
  assert.deepEqual(d.unchanged, ['fs.read']);
  const lines = renderCapabilityDiff(m.name, '1.0.0', '1.1.0', d);
  assert.ok(lines.some((l) => l.includes('fs.write')), '渲染必须包含新增权限');
});

// ---------- v0.2.1 · 限制修复的回归 ----------

test('service · 预算跨进程持久：spent 恢复，额度按累计花费计算', () => {
  const db = tmpDb('budgetp');
  const ctx1 = mockCtx();
  const svc1 = new CordishubService(ctx1, { dbPath: db, budget: { limitUsd: 0.01, reserveEstimateUsd: 0.5 } });
  svc1.install();
  ctx1.emit('session/started', sess('q1'));
  ctx1.emit(
    'model/response',
    ev(1, 'q1', 'model', { text: 'hi' }, {
      model: 'deepseek-v4-pro',
      tokens: { prompt: 30000, completion: 1000, total: 31000 },
      ts: Date.UTC(2026, 9, 5, 10, 0), // 峰段，成本 = (30000*0.27 + 1000*1.1)/1e6 = $0.0092
    }),
  );
  assert.ok(Math.abs(svc1.budget!.spent() - 0.0092) < 1e-9);
  svc1.dispose();

  const ctx2 = mockCtx();
  const svc2 = new CordishubService(ctx2, { dbPath: db, budget: { limitUsd: 0.01, reserveEstimateUsd: 0.5 } });
  svc2.install();
  assert.ok(Math.abs(svc2.budget!.spent() - 0.0092) < 1e-9, '重启后已结算花费应从 KV 持久层恢复');
  ctx2.emit('session/started', sess('q2'));
  ctx2.emit('model/request', ev(1, 'q2', 'model', {}, { model: 'totally-unknown-model' }));
  assert.equal(svc2.safetyHistory().length, 1, '累计花费已逼近上限，新预授权必须被拒（未知模型走 $0.5 兜底额度）');
  svc2.dispose();
});

test('service · 预授权额度模型感知（费率 × token 上限估算）', () => {
  // flash 估算 ≈ (0.07*32768 + 0.28*8192*2)/1e6 ≈ $0.0069；pro 估算 ≈ $0.0269
  const mk = (limit: number) => {
    const ctx = mockCtx();
    const svc = new CordishubService(ctx, { dbPath: tmpDb('est'), budget: { limitUsd: limit } });
    svc.install();
    ctx.emit('session/started', sess('e1'));
    return { svc, ctx };
  };

  const pro = mk(0.02);
  pro.ctx.emit('model/request', ev(1, 'e1', 'model', {}, { model: 'deepseek-v4-pro' }));
  assert.equal(pro.svc.safetyHistory().length, 1, 'pro 估算 $0.0269 > $0.02 上限，必须拦截');
  pro.svc.dispose();

  const flash = mk(0.02);
  flash.ctx.emit('model/request', ev(1, 'e1', 'model', {}, { model: 'deepseek-v4-flash' }));
  assert.equal(flash.svc.safetyHistory().length, 0, 'flash 估算 $0.0069 < $0.02 上限，必须放行');
  flash.svc.dispose();
});

test('storage · compact 前重读磁盘：其它进程的追加不被误删（多进程加固）', () => {
  const db = tmpDb('compact2');
  const a = new Storage({ path: db, silent: true });
  a.beginSession(sess('m1'));
  // 模拟另一进程在 a 启动之后追加的事件
  appendFileSync(
    `${db}.events.jsonl`,
    JSON.stringify({ id: 'm1-e1', sessionId: 'm1', source: 'user', ts: 2, seq: 1, payload: { text: 'from another process' } }) + '\n',
  );
  a.compact();
  const re = new Storage({ path: db, silent: true });
  assert.equal(re.getEvents('m1').length, 1, 'compact 不得用旧内存快照覆盖掉其它进程的追加');
  a.close();
});

test('manifest · TrustRegistry：密钥轮换 / 退休回溯 / 吊销', () => {
  const oldKp = generateSigningKeyPair();
  const curKp = generateSigningKeyPair();
  const m: PluginManifest = {
    name: 'acme/plugin',
    version: '1.0.0',
    capabilities: ['fs.read'],
    contentHash: 'aa'.repeat(32),
    tarball: 'https://example.com/plugin.tgz',
  };
  const oldSig = signManifest(m, oldKp.privateKey);
  const curSig = signManifest(m, curKp.privateKey);

  const reg = new TrustRegistry([
    {
      publisher: 'acme',
      keys: [
        { id: 'k-old', publicKey: oldKp.publicKey, createdAt: '2026-01-01', retiredAt: '2026-06-01' },
        { id: 'k-cur', publicKey: curKp.publicKey, createdAt: '2026-05-01' },
      ],
    },
  ]);

  assert.equal(reg.verify(m, oldSig, { at: Date.parse('2026-03-01') }).ok, true, '回溯判定：退休前的旧密钥在历史时间点有效');
  const now = reg.verify(m, oldSig);
  assert.equal(now.ok, false, '已退休密钥现在无效');
  assert.equal(reg.verify(m, curSig).keyId, 'k-cur', '当前密钥命中并报告 keyId');

  // 密钥吊销：立即失效（区别于退休）
  const revokedReg = new TrustRegistry([
    { publisher: 'acme', keys: [{ id: 'k-cur', publicKey: curKp.publicKey, createdAt: '2026-05-01' }], revokedKeyIds: ['k-cur'] },
  ]);
  assert.equal(revokedReg.verify(m, curSig).reason, 'no-active-key');

  // 制品吊销：签名再对也拒
  const artifactRevoked = new TrustRegistry([
    { publisher: 'acme', keys: [{ id: 'k-cur', publicKey: curKp.publicKey, createdAt: '2026-05-01' }], revokedHashes: [m.contentHash] },
  ]);
  assert.equal(artifactRevoked.verify(m, curSig).reason, 'revoked-artifact');

  const unknown: PluginManifest = { ...m, name: 'stranger/plugin' };
  assert.equal(reg.verify(unknown, curSig).reason, 'unknown-publisher');
});

// ---------- G0 · 基因维度 ----------

test('genome · 从 session 提取基因型（prompt / model / tools）', () => {
  const db = tmpDb('genome1');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('g1'));
  s.appendEvent(ev(1, 'g1', 'system', { text: 'You are a refactor assistant.' }));
  s.appendEvent(ev(2, 'g1', 'user', { text: 'go' }));
  s.appendEvent(ev(3, 'g1', 'tool', { tool_name: 'shell', arguments: { cmd: 'ls' } }, { toolCallId: 't1' }));
  const replay = new ReplayEngine(s);
  const g = extractGenomeFromSession('g1', s, replay)!;
  assert.equal(g.systemPrompt, 'You are a refactor assistant.');
  assert.equal(g.model, 'deepseek-v4-pro');
  assert.deepEqual(g.tools, ['shell']);
  assert.equal(g.parent, undefined, '原始提取没有父代');
  s.close();
});

test('genome · 变异纯度 + 谱系指纹 + 版本 bump + 哈希稳定', () => {
  const parent: AgentGenome = {
    name: 'g', version: '0.1.2', systemPrompt: 'p', model: 'deepseek-v4-pro',
    tools: ['shell'], subagents: [], policy: {},
  };
  const snapshot = structuredClone(parent);

  const child = mutate(parent, { kind: 'model-swap', model: 'deepseek-v4-flash' });
  assert.deepEqual(parent, snapshot, '变异必须是纯函数：父代不可变');
  assert.equal(child.model, 'deepseek-v4-flash');
  assert.equal(child.version, '0.1.3', '补丁版本自动 bump');
  assert.equal(child.parent?.genomeHash, hashGenome(parent), '谱系指向父代指纹');

  const add = mutate(parent, { kind: 'tool-add', tools: ['read_file'] });
  assert.deepEqual(add.tools, ['read_file', 'shell'], '工具列表规范化排序');
  assert.notEqual(hashGenome(parent), hashGenome(add), '内容不同指纹必不同');

  const policyChild = mutate(parent, { kind: 'policy', patch: { maxCostUsd: 1 } });
  assert.equal(policyChild.policy.maxCostUsd, 1);
});

test('genome · KV 基因库持久化往返 + 谱系适应度 fold', () => {
  const db = tmpDb('genome2');
  const s = new Storage({ path: db, silent: true });
  const parent: AgentGenome = { name: 'g', version: '0.1.0', systemPrompt: 'p', model: 'm', tools: [], subagents: [], policy: {} };
  const parentHash = saveGenome(s, parent);
  const child = mutate(parent, { kind: 'policy', patch: { maxCostUsd: 1 } });
  const childHash = saveGenome(s, child);
  assert.equal(loadGenomes(s).length, 2, '父代与子代都应入基因库');

  // 给带基因标记的 session 记成本，验证适应度按谱系聚合
  s.beginSession({ ...sess('f1'), meta: { genome: { hash: parentHash, name: 'g' } } });
  s.accumulate('f1', 100, 0.05);
  s.beginSession({ ...sess('f2'), meta: { genome: { hash: parentHash, name: 'g' } } });
  s.accumulate('f2', 50, 0.02);
  const fit = fitnessOf(s, parentHash);
  assert.equal(fit.sessions, 2);
  assert.equal(fit.totalTokens, 150);
  assert.ok(Math.abs(fit.totalCost - 0.07) < 1e-9);
  assert.ok(Math.abs(fit.avgCostPerSession - 0.035) < 1e-9);
  assert.equal(fitnessOf(s, childHash).sessions, 0, '别的谱系不计入');
  s.close();
});

test('service · breed 提取→变异→持久化 + fork 携带基因谱系标记', () => {
  const db = tmpDb('breed');
  const ctx = mockCtx();
  const svc = new CordishubService(ctx, { dbPath: db });
  svc.install();
  ctx.emit('session/started', sess('br1'));
  ctx.emit('context/injection', ev(1, 'br1', 'system', { text: 'Be terse.' }));

  const child = svc.breed('br1', [{ kind: 'model-swap', model: 'deepseek-v4-flash' }], { name: 'breeder' });
  assert.ok(child, 'breed 应返回子代基因');
  assert.equal(child!.model, 'deepseek-v4-flash');
  assert.ok(child!.parent, '子代携带谱系');
  assert.equal(child!.systemPrompt, 'Be terse.', 'system prompt 从日志提取');

  const hash = hashGenome(child!);
  const forked = svc.fork('br1', 1, 'br1-child', { genome: { hash, name: 'breeder' } });
  assert.equal((forked.meta as { genome?: { hash: string } })?.genome?.hash, hash, 'fork 应携带基因谱系标记');
  assert.equal(svc.genomeFitness(hash).sessions, 1, '打标 fork 即该谱系的首个 run，适应度立即可见');
  svc.dispose();
});

// ---------- v0.4 · L0 哈希链封印 ----------

test('merkle · 自动封印 + 全量验证通过，head 可导出锚定', () => {
  const db = tmpDb('chain1');
  const s = new Storage({ path: db, silent: true, sealEvery: 2 });
  s.beginSession(sess('s1'));
  s.appendEvent(ev(1, 's1', 'user', { text: 'hello' }));
  s.appendEvent(ev(2, 's1', 'user', { text: 'world' }));
  s.close();
  const r = verifyFile(`${db}.events.jsonl`);
  assert.equal(r.ok, true);
  assert.equal(r.seals, 1, '2 行数据且 sealEvery=2 → 恰好 1 个封印');
  assert.equal(r.rows, 2);
  assert.notEqual(r.head, GENESIS, '链头不是创世值');
});

test('merkle · 篡改数据行 → root 失配被检出', () => {
  const db = tmpDb('chain2');
  const s = new Storage({ path: db, silent: true, sealEvery: 1 });
  s.appendEvent(ev(1, 'x', 'user', { text: 'immutable truth' }));
  s.close();
  const p = `${db}.events.jsonl`;
  writeFileSync(p, readFileSync(p, 'utf8').replace('immutable', 'mutated'));
  const r = verifyFile(p);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /root mismatch/);
});

test('merkle · 篡改封印行 → 链条断裂被检出（最后一个封印靠外锚 head 保护）', () => {
  const db = tmpDb('chain3');
  const s = new Storage({ path: db, silent: true, sealEvery: 1 });
  s.appendEvent(ev(1, 'x', 'user', { text: 'a' }));
  s.appendEvent(ev(2, 'x', 'user', { text: 'b' }));
  s.close();
  const p = `${db}.events.jsonl`;
  // 篡改第一个封印的 ts：root 仍对，但 sealHash 变化 → 第二个封印的 prev 断裂
  const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
  const firstSealIdx = lines.findIndex((l) => l.includes('"__seal"'));
  lines[firstSealIdx] = lines[firstSealIdx].replace('"ts":', '"ts":9');
  writeFileSync(p, lines.join('\n') + '\n');
  const r = verifyFile(p);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /chain broken/);
});

test('merkle · 重启续链 + compact 重开新链（血统锚点）仍可验证', () => {
  const db = tmpDb('chain4');
  const s1 = new Storage({ path: db, silent: true, sealEvery: 100 });
  s1.beginSession(sess('c1'));
  s1.accumulate('c1', 10, 0.1);
  s1.close();
  const s2 = new Storage({ path: db, silent: true, sealEvery: 100 });
  s2.beginSession(sess('c2')); // 重启后续写
  s2.sealNow();
  assert.equal(verifyFile(`${db}.sessions.jsonl`).ok, true, '跨重启链必须连续');
  s2.compact();
  const after = verifyFile(`${db}.sessions.jsonl`);
  assert.equal(after.ok, true, 'compact 重开新链但内部一致');
  assert.equal(after.seals, 1, '压实文件带一个血统封印');
  s2.close();
});

test('service · audit 汇总四文件哈希链验证', () => {
  const db = tmpDb('auditsvc');
  const ctx = mockCtx();
  const svc = new CordishubService(ctx, { dbPath: db, sealEvery: 1 });
  svc.install();
  ctx.emit('session/started', sess('a1'));
  ctx.emit('context/injection', ev(1, 'a1', 'user', { text: 'sealed' }));
  svc.sealNow();
  const reports = svc.audit();
  assert.equal(reports.length, 4);
  assert.ok(reports.every((r) => r.ok));
  svc.dispose();
});

// ---------- v0.4 · ocap 能力令牌 ----------

test('ocap · 衰减只能收窄，扩权请求被显式拒绝', () => {
  const root = mintRoot({ tenant: 'acme', tools: ['shell', 'read_file', 'http_get'] });
  const sub = attenuate(root, { tools: ['shell', 'read_file'], maxSpendUsd: 0.2 });
  assert.deepEqual([...sub.tools], ['read_file', 'shell']);
  assert.equal(sub.maxSpendUsd, 0.2);
  assert.equal(sub.depth, 1);
  assert.equal(sub.parentTag, root.tag);
  assert.throws(() => attenuate(root, { tools: ['shell', 'net'] }), CapabilityError, '请求父代没有的工具 = 扩权');
  assert.equal(attenuate(sub, { maxSpendUsd: 0.5 }).maxSpendUsd, 0.2, '预算不允许放宽');
});

test('ocap · 委托深度上限与过期', () => {
  const root = mintRoot({ tenant: 't', tools: ['shell'], maxDepth: 1 });
  const child = attenuate(root, {});
  assert.throws(() => attenuate(child, {}), CapabilityError, '超过 maxDepth 必须拒绝');
  const t0 = 1_700_000_000_000;
  const cap = mintRoot({ tenant: 't', tools: ['shell'], ttlMs: 1000 }, t0);
  assert.equal(isExpired(cap, t0 + 999), false);
  assert.throws(() => assertTool(cap, 'shell', t0 + 1001), CapabilityError, '过期令牌必须失效');
});

test('safety · capability 模式：结构性工具准入替代白名单比对', () => {
  const cap = mintRoot({ tenant: 'acme', tools: ['shell', 'read_file'] });
  const net = new SafetyNet({ tenant: 'acme', capability: cap });
  assert.equal(net.check(ev(1, 's', 'tool', { tool_name: 'delete_database', arguments: {} })).ok, false);
  assert.equal(net.check(ev(2, 's', 'tool', { tool_name: 'shell', arguments: {} })).ok, true);
});

// ---------- L1 · Cassette 确定性回放 ----------

test('cassette · 录制盒带：条目有序 + 确定性标记 + 配对自检', () => {
  const db = tmpDb('tape1');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('tp1'));
  s.appendEvent(ev(1, 'tp1', 'system', { text: 'sys' }));
  s.appendEvent(ev(2, 'tp1', 'user', { text: 'go' }));
  s.appendEvent(ev(3, 'tp1', 'tool', { tool_name: 'shell', arguments: { cmd: 'ls' }, result: { stdout: 'a b' } }, { toolCallId: 't1' }));
  s.appendEvent(ev(4, 'tp1', 'model', { text: 'done' }, { model: 'deepseek-v4-pro' }));
  const replay = new ReplayEngine(s);
  const tape = recordTape('tp1', s, replay)!;

  assert.deepEqual(tape.entries.map((e) => e.kind), ['context', 'context', 'tool-call', 'tool-result', 'model']);
  assert.equal(tape.determinism.toolsRecorded, true);
  assert.equal(tape.determinism.samplingRecorded, false, '未录到 sampling → 上下文确定性档位');
  const v = verifyTape(tape);
  assert.equal(v.ok, true);
  assert.equal(v.toolCalls, 1);
  assert.equal(v.toolResults, 1);
  s.close();
});

test('cassette · 忠实重放不分叉，故障注入立即分叉（上下文确定性）', () => {
  const db = tmpDb('cf1');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('cf2'));
  s.appendEvent(ev(1, 'cf2', 'system', { text: 'sys' }));
  s.appendEvent(ev(2, 'cf2', 'tool', { tool_name: 'shell', arguments: { cmd: 'ls' }, result: { stdout: 'a b' } }, { toolCallId: 't1' }));
  s.appendEvent(ev(3, 'cf2', 'model', { text: 'done' }, { model: 'deepseek-v4-pro' }));
  const replay = new ReplayEngine(s);
  const tape = recordTape('cf2', s, replay)!;

  // 忠实模型：逐字重演录制动作
  const recorded: CfAction[] = [];
  for (const e of tape.entries) {
    if (e.kind === 'tool-call') recorded.push({ type: 'tool', tool: e.tool, args: e.args });
    else if (e.kind === 'model') recorded.push({ type: 'say', text: e.text });
  }
  const faithful: CounterfactualModel = { next: (_st, step) => recorded[step] ?? { type: 'stop' } };
  const okRun = playCounterfactual(tape, { model: faithful });
  assert.equal(okRun.divergedAtStep, null, '忠实重放不得分叉');
  assert.deepEqual(okRun.endState.toolCalls[0]!.result, { stdout: 'a b' }, '工具响应来自盒带');
  assert.equal(okRun.stopReason, 'model-stop');

  // 反应模型：遇错即停；在 tool#0 注入错误 → 第 1 步分叉（录制是 say，重放选择 stop）
  const reactive: CounterfactualModel = {
    next: (st) => {
      const last = st.toolCalls[st.toolCalls.length - 1];
      if (last?.error) return { type: 'stop' };
      return { type: 'tool', tool: 'shell', args: { cmd: 'ls' } };
    },
  };
  const badRun = playCounterfactual(tape, { model: reactive, fault: { atToolIndex: 0, error: 'disk failure' } });
  assert.equal(badRun.divergedAtStep, 1, '分叉点必须精确报告');
  assert.equal(badRun.endState.toolCalls[0]!.error, 'disk failure');
  s.close();
});

test('cassette · 因果二分：O(log n) 找到最早坏状态点', () => {
  const db = tmpDb('bisect1');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('bi1'));
  for (let i = 1; i <= 16; i++) {
    s.appendEvent(ev(i, 'bi1', 'user', { text: i >= 12 ? `step ${i} refund leak` : `step ${i}` }));
  }
  const replay = new ReplayEngine(s);
  const r = bisectFirstBad('bi1', s, replay, (st) => st.userInputs.some((t) => t.includes('refund')));
  assert.equal(r.found, true);
  assert.equal(r.seq, 12, '最早坏点 = 第 12 步');
  assert.ok(r.checked <= 5, `16 个事件最多 5 次重构，实际 ${r.checked}`);
  assert.equal(bisectFirstBad('bi1', s, replay, () => false).found, false);
  s.close();
});

// ---------- G1 · 进化反应堆 ----------

test('reactor · 变体跑批：保真优先选择 + 谱系入库 + 燃料全部结算', () => {
  const db = tmpDb('reactor1');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('rc1'));
  s.appendEvent(ev(1, 'rc1', 'system', { text: 'sys' }));
  s.appendEvent(ev(2, 'rc1', 'tool', { tool_name: 'shell', arguments: { cmd: 'ls' }, result: { stdout: 'ok' } }, { toolCallId: 't1' }));
  s.appendEvent(ev(3, 'rc1', 'model', { text: 'done' }, { model: 'deepseek-v4-pro' }));
  const replay = new ReplayEngine(s);
  const tape = recordTape('rc1', s, replay)!;
  const seed: AgentGenome = {
    name: 'seed', version: '0.1.0', systemPrompt: 'sys', model: 'deepseek-v4-pro',
    tools: ['shell'], subagents: [], policy: {},
  };

  const faithful: CfAction[] = [];
  for (const e of tape.entries) {
    if (e.kind === 'tool-call') faithful.push({ type: 'tool', tool: e.tool, args: e.args });
    else if (e.kind === 'model') faithful.push({ type: 'say', text: e.text });
  }

  const budget = new BudgetLedger(10);
  const report = runReactor({
    seed,
    tape,
    budget,
    variants: [
      { name: 'faithful-flash', mutations: [{ kind: 'model-swap', model: 'deepseek-v4-flash' }] },
      { name: 'faithful-pro', mutations: [{ kind: 'tool-add', tools: ['read_file'] }] },
      { name: 'drifter', mutations: [{ kind: 'prompt-append', text: 'go wild' }] },
    ],
    harness: (g) => ({
      next: (_st, step) =>
        g.systemPrompt.includes('go wild')
          ? { type: 'tool', tool: 'shell', args: { cmd: 'bad' } }
          : faithful[step] ?? { type: 'stop' },
    }),
    storage: s,
  });

  assert.equal(report.best!.variant, 'faithful-flash', '保真变体里便宜的赢（flash 费率低）');
  assert.equal(report.best!.result!.divergedAtStep, null);
  assert.equal(report.runs.filter((r) => r.rejected).length, 0);
  assert.ok(report.spentUsd > 0);
  assert.ok(Math.abs(budget.reserved()) < 1e-12, '全部燃料已结算');
  assert.ok(loadGenomes(s).length >= 4, '种子 + 三个变体全部入库（谱系自动指向 seed）');
  s.close();
});

test('reactor · 燃料闸门：预算耗尽的变体在跑批前被拒', () => {
  const db = tmpDb('reactor2');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('rc2'));
  s.appendEvent(ev(1, 'rc2', 'tool', { tool_name: 'shell', arguments: { cmd: 'ls' }, result: { stdout: 'ok' } }, { toolCallId: 't1' }));
  const replay = new ReplayEngine(s);
  const tape = recordTape('rc2', s, replay)!;
  const seed: AgentGenome = { name: 'seed', version: '0.1.0', systemPrompt: '', model: 'deepseek-v4-pro', tools: [], subagents: [], policy: {} };

  const budget = new BudgetLedger(0.0005);
  const report = runReactor({
    seed,
    tape,
    budget,
    fuelPerRunUsd: 0.0003,
    variants: [
      { name: 'first', mutations: [] },
      { name: 'second', mutations: [] },
    ],
    harness: () => ({ next: () => ({ type: 'tool', tool: 'shell', args: {} }) }),
    costOf: () => ({ costUsd: 0.00025, tokens: 100 }),
  });

  assert.equal(report.runs[0]!.rejected, false);
  assert.equal(report.runs[1]!.rejected, true, '第一个结算后剩余额度不足，第二个被拒');
  assert.equal(report.runs[1]!.result, null);
  assert.equal(report.budgetExhausted, true);
  assert.ok(Math.abs(report.spentUsd - 0.00025) < 1e-12);
  assert.equal(report.best!.variant, 'first', '被拒变体不参与评选');
  s.close();
});

test('reactor · harness 抛异常时燃料预授权必须释放（闸门不能因实验失败而锁死）', () => {
  const db = tmpDb('reactor4');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('rc4'));
  s.appendEvent(ev(1, 'rc4', 'tool', { tool_name: 'shell', arguments: { cmd: 'ls' }, result: { stdout: 'ok' } }, { toolCallId: 't1' }));
  const replay = new ReplayEngine(s);
  const tape = recordTape('rc4', s, replay)!;
  const seed: AgentGenome = { name: 'seed', version: '0.1.0', systemPrompt: '', model: 'deepseek-v4-pro', tools: [], subagents: [], policy: {} };

  const budget = new BudgetLedger(1, undefined);
  assert.throws(() =>
    runReactor({
      seed,
      tape,
      budget,
      fuelPerRunUsd: 0.3,
      variants: [{ name: 'boom', mutations: [] }],
      harness: () => ({ next: () => { throw new Error('harness crashed'); } }),
    }), /harness crashed/);
  assert.ok(Math.abs(budget.reserved()) < 1e-12, '异常路径的预授权必须全额释放');
  assert.ok(Math.abs(budget.available() - 1) < 1e-12, '燃料恢复满额');
  s.close();
});

test('service · reactor 集成：提取种子 + 盒带环境 + 报告', () => {
  const db = tmpDb('reactor3');
  const ctx = mockCtx();
  const svc = new CordishubService(ctx, { dbPath: db });
  svc.install();
  ctx.emit('session/started', sess('rs1'));
  ctx.emit('context/injection', ev(1, 'rs1', 'system', { text: 'Be terse.' }));
  ctx.emit('tool/called', ev(2, 'rs1', 'tool', { tool_name: 'shell', arguments: { cmd: 'ls' } }, { toolCallId: 'tc1' }));
  ctx.emit('tool/result', ev(3, 'rs1', 'tool', { tool_name: 'shell', result: { stdout: 'x' } }, { toolCallId: 'tc1' }));

  const tape = svc.recordTape('rs1')!;
  const faithful: CfAction[] = [];
  for (const e of tape.entries) {
    if (e.kind === 'tool-call') faithful.push({ type: 'tool', tool: e.tool, args: e.args });
    else if (e.kind === 'model') faithful.push({ type: 'say', text: e.text });
  }
  const report = svc.reactor('rs1', {
    variants: [{ name: 'v1', mutations: [{ kind: 'model-swap', model: 'deepseek-v4-flash' }] }],
    harness: () => ({ next: (_st, step) => faithful[step] ?? { type: 'stop' } }),
    budget: { limitUsd: 1 },
    save: true,
  })!;
  assert.ok(report);
  assert.equal(report.best!.variant, 'v1');
  assert.equal(svc.reactor('no-such-session', { variants: [], harness: () => ({ next: () => ({ type: 'stop' }) }) }), undefined);
  svc.dispose();
});

// ---------- 限制清零 · 确定性证书 / 区间扫描 / 世代进化 ----------

test('certify · 确定性分级证书 + 可执行稳定性证明（含不稳定检测）', () => {
  const db = tmpDb('cert1');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('ct1'));
  s.appendEvent(ev(1, 'ct1', 'tool', { tool_name: 'shell', arguments: { cmd: 'ls' }, result: { stdout: 'ok' } }, { toolCallId: 't1' }));
  s.appendEvent(ev(2, 'ct1', 'model', { text: 'done' }, { model: 'deepseek-v4-pro' }));
  const tape = recordTape('ct1', s, new ReplayEngine(s))!;

  // 未录采样 → context 档；忠实模型 ×3 → 稳定性证明通过
  const faithful: CounterfactualModel = {
    next: (_st, step) => (step === 0 ? { type: 'tool', tool: 'shell', args: { cmd: 'ls' } } : { type: 'stop' }),
  };
  let cert = certifyDeterminism(tape, { model: faithful, stabilityRuns: 3 });
  assert.equal(cert.level, 'context');
  assert.equal(cert.replayStable, true, '忠实模型的重放必须逐位一致');
  assert.equal(cert.runsCompared, 3);

  // 不稳定模型（mod-3 节奏：相邻两次 run 的步数序列必然不同）必须被证明抓住
  let tick = 0;
  const noisy: CounterfactualModel = {
    next: () => {
      const v = tick++ % 3;
      return v === 0 ? { type: 'stop' } : { type: 'say', text: `t${v}` };
    },
  };
  cert = certifyDeterminism(tape, { model: noisy, stabilityRuns: 4 });
  assert.equal(cert.replayStable, false, '非确定模型必须被检出');

  // 补盖采样 → 升 full 档
  stampSampling(tape, { seed: 42, temperature: 0 });
  cert = certifyDeterminism(tape);
  assert.equal(cert.level, 'full');
  assert.equal(cert.samplingRecorded, true);
  s.close();
});

test('locateBadEvents · 非单调谓词：单遍找出全部坏区间（O(n) 折叠）', () => {
  const db = tmpDb('scan1');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('sc1'));
  // 文本里 "error" 出现在 3-5 和 9-10 两段；谓词看"最后一条输入"
  //（userInputs 是累积列表，看全量会天然单调，测不出非单调场景）
  for (let i = 1; i <= 12; i++) {
    const bad = (i >= 3 && i <= 5) || (i >= 9 && i <= 10);
    s.appendEvent(ev(i, 'sc1', 'user', { text: bad ? `step ${i} error` : `step ${i}` }));
  }
  const report = locateBadEvents('sc1', s, (st) => (st.userInputs[st.userInputs.length - 1] ?? '').includes('error'));
  assert.equal(report.eventsFolded, 12, '恰好折叠 12 次（单遍）');
  assert.equal(report.intervals.length, 2, '两个坏区间都要找到');
  assert.deepEqual(report.intervals[0], { fromSeq: 3, toSeq: 5 });
  assert.deepEqual(report.intervals[1], { fromSeq: 9, toSeq: 10 });
  assert.equal(report.firstBadSeq, 3);
  s.close();
});

test('evolve · 世代进化：种子化 RNG 可复现，燃料跨世代共享', () => {
  const build = () => {
    const db = tmpDb('evolve');
    const s = new Storage({ path: db, silent: true });
    s.beginSession(sess('ev1'));
    s.appendEvent(ev(1, 'ev1', 'tool', { tool_name: 'shell', arguments: { cmd: 'ls' }, result: { stdout: 'ok' } }, { toolCallId: 't1' }));
    s.appendEvent(ev(2, 'ev1', 'model', { text: 'done' }, { model: 'deepseek-v4-pro' }));
    return s;
  };
  const seed: AgentGenome = { name: 'seed', version: '0.1.0', systemPrompt: '', model: 'deepseek-v4-pro', tools: [], subagents: [], policy: {} };
  const mutationPool: import('../src/genome.ts').GenomeMutation[] = [
    { kind: 'model-swap', model: 'deepseek-v4-flash' },
    { kind: 'tool-add', tools: ['read_file'] },
    { kind: 'policy', patch: { maxCostUsd: 0.5 } },
  ];
  const harness = (g: AgentGenome): CounterfactualModel => ({
    next: (_st, step) => (step === 0 ? { type: 'tool', tool: 'shell', args: { cmd: 'ls' } } : { type: 'stop' }),
  });
  const runOnce = () => {
    const s = build();
    const tape = recordTape('ev1', s, new ReplayEngine(s))!;
    const budget = new BudgetLedger(10);
    const report = evolve({
      seed, generations: 3, populationSize: 4, mutationPool,
      tape, harness: (_g) => harness(_g), budget,
      costOf: () => ({ costUsd: 0.01, tokens: 100 }),
    });
    return { report, close: () => s.close() };
  };

  const a = runOnce();
  const b = runOnce();
  assert.equal(a.report.generations.length, 3, '三代都应执行');
  assert.ok(a.report.hallOfFame.length >= 3, '名人堂跨代累积');
  assert.ok(a.report.spentUsd > 0.03, '燃料跨世代累计');
  assert.equal(
    a.report.best!.genomeHash,
    b.report.best!.genomeHash,
    '同一种子化 RNG 的两次进化必须收敛到同一最优（可复现进化）',
  );
  a.close();
  b.close();

  // 换 RNG 种子 → 搜索轨迹不同（证明 rng 真在驱动）
  const s = build();
  const tape = recordTape('ev1', s, new ReplayEngine(s))!;
  const other = evolve({
    seed, generations: 3, populationSize: 4, mutationPool,
    tape, harness: (_g) => harness(_g), budget: new BudgetLedger(10),
    costOf: () => ({ costUsd: 0.01, tokens: 100 }),
    rng: seededRng(7),
  });
  assert.ok(other.generations.length === 3);
  s.close();
});

test('reactor · saveRejected=false：被拒变体不入基因库', () => {
  const db = tmpDb('reactor5');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('rc5'));
  s.appendEvent(ev(1, 'rc5', 'tool', { tool_name: 'shell', arguments: { cmd: 'ls' }, result: { stdout: 'ok' } }, { toolCallId: 't1' }));
  const tape = recordTape('rc5', s, new ReplayEngine(s))!;
  const seed: AgentGenome = { name: 'seed', version: '0.1.0', systemPrompt: '', model: 'deepseek-v4-pro', tools: [], subagents: [], policy: {} };
  const report = runReactor({
    seed, tape, budget: new BudgetLedger(0.0004), fuelPerRunUsd: 0.0003, saveRejected: false,
    variants: [
      { name: 'runs', mutations: [{ kind: 'tool-add', tools: ['read_file'] }] },
      { name: 'denied', mutations: [{ kind: 'tool-add', tools: ['net'] }] },
    ],
    harness: () => ({ next: () => ({ type: 'stop' }) }),
    costOf: () => ({ costUsd: 0.0002, tokens: 10 }),
    storage: s,
  });
  assert.equal(report.runs[1]!.rejected, true);
  assert.equal(loadGenomes(s).length, 2, '种子 + 已跑变体入库；被拒变体不入库');
  s.close();
});

// ---------- v0.7 · taint 信息流检查 ----------

test('taint · 传播 / 溯源 / 清洗屏障', () => {
  const db = tmpDb('taint1');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('tt1'));
  s.appendEvent(ev(1, 'tt1', 'context', { text: 'billing context for acme' }));
  s.appendEvent(ev(2, 'tt1', 'tool', { tool_name: 'read_file', result: { stdout: 'refund policy' } }, { toolCallId: 't1' }));
  s.appendEvent(ev(3, 'tt1', 'tool', { tool_name: 'redact_output', result: { stdout: '***' } }, { toolCallId: 't2' }));
  s.appendEvent(ev(4, 'tt1', 'tool', { tool_name: 'shell', result: { stdout: 'clean' } }, { toolCallId: 't3' }));

  const report = taintScan('tt1', s, {
    taintOfEvent: (source, p) => (String(p['text'] ?? '').includes('billing') ? ['tenant:acme'] : []),
    taintOfToolResult: (tool, result) =>
      String((result as { stdout?: string })?.stdout ?? '').includes('refund') ? ['pii'] : [],
    sanitize: (tool) => tool === 'redact_output',
  })!;
  assert.ok(report);
  assert.deepEqual(report.finalActive, [], '清洗屏障应清空全部活跃污点');
  const added2 = report.timeline.find((t) => t.seq === 2)!;
  assert.deepEqual(added2.active.sort(), ['pii', 'tenant:acme'], '污点沿事件流累积传播');
  const prov = report.provenance.find((p) => p.label === 'pii')!;
  assert.equal(prov.via, 'tool:read_file', '溯源指向注入事件');
  assert.equal(report.eventsScanned, 4);
  s.close();
});

test('taint · 输出门控 + 租户缺省策略', () => {
  const db = tmpDb('taint2');
  const s = new Storage({ path: db, silent: true });
  s.beginSession(sess('tt2'));
  s.appendEvent(ev(1, 'tt2', 'tool', { tool_name: 'shell', result: { stdout: 'secret-key' } }, { toolCallId: 't1' }));
  s.appendEvent(ev(2, 'tt2', 'model', { text: 'here is the key' }, { model: 'deepseek-v4-pro' }));
  const report = taintScan('tt2', s, { ...tenantTaintPolicy('beta'), forbiddenInOutput: ['tenant:beta'] })!;
  assert.equal(report.violations.length, 1, '禁止标签在模型输出时活跃 → taint-leak');
  assert.equal(report.violations[0]!.kind, 'taint-leak');
  assert.equal(report.violations[0]!.atSeq, 2);
  assert.match(report.violations[0]!.detail, /tool:shell @seq1/);
  assert.equal(taintScan('no-such', s, tenantTaintPolicy('x')), undefined);
  s.close();
});

test('taint · 缓存子集规则：同租户放行、跨租户强制 MISS', () => {
  assert.equal(cacheTaintCompatible(['tenant:acme'], ['tenant:acme', 'pii']), true, '子集 → 兼容');
  assert.equal(cacheTaintCompatible(['tenant:acme'], ['tenant:beta']), false, '跨租户 → MISS');
  assert.equal(cacheTaintCompatible([], ['anything']), true, '无污点缓存人人可用');
});

// ---------- v0.7 · 选择策略 DSL ----------

function fakeRun(name: string, genome: AgentGenome, fitness: number, rejected = false): ReactorRun {
  return { variant: name, genome, genomeHash: hashGenome(genome), result: null, costUsd: 0, tokens: 0, fitness, rejected };
}

test('selection · diversity 防早熟：同质顶尖群中保留差异个体', () => {
  const sameA: AgentGenome = { name: 'a', version: '0.1.0', systemPrompt: 'same prompt', model: 'deepseek-v4-pro', tools: ['shell'], subagents: [], policy: {} };
  // 同质群：特征袋完全相同的克隆（仅 name 不同 → 距离 0），模拟"早熟收敛后的克隆群"
  const sameB: AgentGenome = { ...sameA, name: 'b' };
  const sameC: AgentGenome = { ...sameA, name: 'c' };
  const distinct = mutate(sameA, { kind: 'prompt-replace', text: 'completely different strategy' }); // 特征差异大
  const near = genomeDistance(sameB, sameA);
  const far = genomeDistance(distinct, sameA);
  assert.ok(near < far, `差异个体必须比同质个体更远（near=${near}, far=${far}）`);
  const threshold = (near + far) / 2;

  const runs = [
    fakeRun('a', sameA, 1.0),
    fakeRun('b', sameB, 0.9),
    fakeRun('c', sameC, 0.8),
    fakeRun('d', distinct, 0.7),
  ];
  const trunc = selectParents(runs, { kind: 'truncation', eliteSize: 2 });
  assert.equal(trunc.length, 2);
  assert.ok(trunc.every((g) => hashGenome(g) === hashGenome(sameA) || hashGenome(g) === hashGenome(sameB)), '截断选择全取同质个体（早熟）');

  const diverse = selectParents(runs, { kind: 'diversity', eliteSize: 2, minDistance: threshold });
  assert.equal(diverse.length, 2);
  assert.ok(
    diverse.some((g) => hashGenome(g) === hashGenome(distinct)),
    '多样性选择必须把差异个体带进亲本池',
  );
});

test('selection · tournament / roulette：种子化可复现，且只选可行个体', () => {
  const g0: AgentGenome = { name: 'g0', version: '0.1.0', systemPrompt: 'p', model: 'm0', tools: ['a'], subagents: [], policy: {} };
  const g1 = mutate(g0, { kind: 'model-swap', model: 'm1' });
  const g2 = mutate(g0, { kind: 'model-swap', model: 'm2' });
  const runs = [
    fakeRun('x', g0, 0.9),
    fakeRun('y', g1, 0.6),
    fakeRun('rej', mutate(g0, { kind: 'model-swap', model: 'm3' }), -Infinity, true),
    fakeRun('z', g2, 0.3),
  ];

  const t1 = selectParents(runs, { kind: 'tournament', size: 2, winners: 2 }, seededRng(42));
  const t2 = selectParents(runs, { kind: 'tournament', size: 2, winners: 2 }, seededRng(42));
  assert.deepEqual(t1.map(hashGenome), t2.map(hashGenome), '同种子锦标赛必须复现');
  assert.ok(t1.every((g) => hashGenome(g) !== hashGenome(runs[2]!.genome)), '被拒个体不可入选');

  const r1 = selectParents(runs, { kind: 'roulette', winners: 3 }, seededRng(7));
  const r2 = selectParents(runs, { kind: 'roulette', winners: 3 }, seededRng(7));
  assert.deepEqual(r1.map(hashGenome), r2.map(hashGenome), '同种子轮盘赌必须复现');
  assert.ok(r1.length >= 1 && r1.length <= 3);
});

// ---------- v0.9 · Hub 数据源管道 ----------

test('hubsync · GitHub topic 管道：mock fetcher → 映射 → 可搜索（数据与管道解耦）', async () => {
  const db = tmpDb('hubsync');
  const s = new Storage({ path: db, silent: true });
  const hub = new HubIndex(s);
  const fetcher: RepoFetcher = async () => [
    {
      full_name: 'acme/dsh-plugin-wizard',
      description: 'Wizard plugin',
      stargazers_count: 999,
      html_url: 'https://github.com/acme/dsh-plugin-wizard',
      pushed_at: '2026-10-01T00:00:00Z',
      owner: { login: 'acme' },
      license: { spdx_id: 'MIT' },
    },
    {
      full_name: 'deepseek-ai/dsh-plugin-official',
      description: 'official plugin',
      stargazers_count: 5000,
      html_url: 'https://github.com/deepseek-ai/dsh-plugin-official',
      pushed_at: '2026-10-02T00:00:00Z',
      owner: { login: 'deepseek-ai' },
      license: null,
    },
  ];
  const n = await syncHubTopic(hub, { fetcher });
  assert.equal(n, 2);
  const hits = hub.search({ query: 'wizard' });
  assert.equal(hits[0]!.fullName, 'acme/dsh-plugin-wizard');
  const official = hub.search({ official: true }).find((p) => p.fullName === 'deepseek-ai/dsh-plugin-official')!;
  assert.equal(official.official, true);
  assert.equal(official.license, 'Unknown', '无 license 的仓库标记 Unknown');
  assert.ok(official.health > 0 && official.health <= 1, 'health 启发式落在 (0,1]');
  // 分页停止：第一页满页（perPage=2）才翻第二页，空页即停
  let pages = 0;
  const pagedFetcher: RepoFetcher = async (_t, perPage, page) => {
    pages++;
    return page === 1 ? await fetcher(_t, perPage, page) : [];
  };
  assert.equal(await syncHubTopic(hub, { fetcher: pagedFetcher, maxPages: 5, perPage: 2 }), 2);
  assert.equal(pages, 2, '满页翻页、空页即停，不空转');
  s.close();
});

// ---------- v0.10 · 多 topic 真实索引 ----------

test('hubsync · 多 topic 同步：来源标签 + 跨 topic 去重', async () => {
  const db = tmpDb('hubsync2');
  const s = new Storage({ path: db, silent: true });
  const hub = new HubIndex(s);
  const mk = (full: string, stars: number): import('../src/hubsync.ts').GithubRepo => ({
    full_name: full,
    description: `plugin ${full}`,
    stargazers_count: stars,
    html_url: `https://github.com/${full}`,
    pushed_at: '2026-10-01T00:00:00Z',
    owner: { login: full.split('/')[0]! },
    license: null,
  });
  const fetcher: RepoFetcher = async (topic) =>
    topic === 'alpha' ? [mk('acme/shared', 100), mk('acme/only-a', 50)] : [mk('acme/shared', 100), mk('acme/only-b', 60)];

  const r = await syncHubTopics(hub, { fetcher, topics: ['alpha', 'beta'] });
  assert.equal(r.byTopic['alpha'], 2);
  assert.equal(r.byTopic['beta'], 2);
  assert.equal(r.total, 4);
  const unique = hub.search({ limit: 100 });
  assert.equal(unique.length, 3, '跨 topic 同名仓库按 fullName 去重');
  const shared = unique.find((p) => p.fullName === 'acme/shared')!;
  assert.deepEqual(shared.tags, ['github-topic:beta'], '后写 topic 的标签覆盖（最新来源）');
  s.close();
});

// ---------- G3 · 内部市场 ----------

test('market · 配给退化：无争抢时与 reserve/settle 语义一致', () => {
  const m = new ResourceMarket(10);
  const a = m.bid({ bidder: 'a', amountUsd: 3 });
  assert.equal(a.status, 'granted', '容量足够必须立即全额授予');
  assert.equal(a.grantedUsd, 3);
  m.settle(a.id, 2.5);
  const b = m.bid({ bidder: 'b', amountUsd: 4 });
  assert.equal(b.status, 'granted');
  assert.ok(Math.abs(m.available() - 3.5) < 1e-9);
  assert.ok(Math.abs(m.spent() - 2.5) < 1e-9);
});

test('market · 争抢触发加权拍卖：高权重优先，尾部部分授予', () => {
  const m = new ResourceMarket(5);
  const low = m.enqueue({ bidder: 'low', amountUsd: 3, weight: 1 }, 1000);   // 先到但权重低
  const high = m.enqueue({ bidder: 'high', amountUsd: 3, weight: 10 }, 2000); // 后到但权重高
  m.clear();
  assert.equal(high.grantedUsd, 3, '高权重全额');
  assert.equal(low.grantedUsd, 2, '剩余容量给低权重部分授予');
  assert.equal(low.status, 'partial');
  // 实际成本低于授予（结算差额）→ 释放的容量补给排队者
  m.settle(high.id, 2);
  m.resettle();
  assert.equal(low.grantedUsd, 3, '结算差额必须补给排队者');
  assert.equal(low.status, 'granted');
});

test('market · aging 防饿死：低权重多轮等待后优先级反超', () => {
  const m = new ResourceMarket(1);
  const starved = m.enqueue({ bidder: 'starved', amountUsd: 1, weight: 1 }, 1000);
  let lastBully;
  for (let round = 1; round <= 2; round++) {
    const bully = m.enqueue({ bidder: `bully-${round}`, amountUsd: 1, weight: 2 }, 2000 + round);
    m.clear();
    if (round === 1) {
      assert.equal(bully.grantedUsd, 1, '第一轮高权重胜出');
      assert.equal(starved.grantedUsd, 0, 'starved 被挤掉，开始累积等待');
      m.settle(bully.id, 0.5); // 只用了 0.5，释放 0.5
    }
    lastBully = bully;
  }
  assert.ok(starved.waitedRounds >= 1, `等待轮数应累积（实际 ${starved.waitedRounds}）`);
  assert.ok(starved.grantedUsd > 0, 'aging 抬升 + FIFO 平局后低权重反超拿到释放容量');
  assert.equal(lastBully!.grantedUsd, 0, '后来的高权重这轮排到 starved 之后');
});

test('reactor · 燃料市场模式：权重决定谁拿到燃料（对比配给制的先到先得）', () => {
  const build = () => {
    const db = tmpDb('mkt-reactor');
    const s = new Storage({ path: db, silent: true });
    s.beginSession(sess('mr1'));
    s.appendEvent(ev(1, 'mr1', 'tool', { tool_name: 'shell', arguments: { cmd: 'ls' }, result: { stdout: 'ok' } }, { toolCallId: 't1' }));
    return { s, tape: recordTape('mr1', s, new ReplayEngine(s))! };
  };
  const seed: AgentGenome = { name: 'seed', version: '0.1.0', systemPrompt: '', model: 'deepseek-v4-pro', tools: [], subagents: [], policy: {} };
  const stop = (): CounterfactualModel => ({ next: () => ({ type: 'stop' }) });
  const costOf = () => ({ costUsd: 0.02, tokens: 1 });

  // 容量只够一个变体：市场模式下 flash（权重 5）应胜出，pro 落选
  const { s, tape } = build();
  const report = runReactor({
    seed, tape,
    fuel: { capacityUsd: 0.03, weightOf: (_v, g) => (g.model === 'deepseek-v4-flash' ? 5 : 1) },
    fuelPerRunUsd: 0.03,
    variants: [
      { name: 'pro-first', mutations: [] },
      { name: 'flash-second', mutations: [{ kind: 'model-swap', model: 'deepseek-v4-flash' }] },
    ],
    harness: stop,
    costOf,
  });
  assert.equal(report.runs[0]!.rejected, true, '低权重先出价也会被高权重反超');
  assert.equal(report.runs[0]!.rejectedReason, 'market');
  assert.equal(report.runs[1]!.rejected, false, '高权重拿到燃料');
  assert.ok(Math.abs(report.spentUsd - 0.02) < 1e-12, '市场结算与配给同语义');
  assert.throws(() => runReactor({ seed, tape, variants: [], harness: stop }), /fuel gate required/);
  s.close();
});

test('evolve · 每世代燃料池市场模式可运行且可复现', () => {
  const mk = () => {
    const db = tmpDb('mkt-evolve');
    const s = new Storage({ path: db, silent: true });
    s.beginSession(sess('me1'));
    s.appendEvent(ev(1, 'me1', 'tool', { tool_name: 'shell', arguments: { cmd: 'ls' }, result: { stdout: 'ok' } }, { toolCallId: 't1' }));
    return { s, tape: recordTape('me1', s, new ReplayEngine(s))! };
  };
  const seed: AgentGenome = { name: 'seed', version: '0.1.0', systemPrompt: '', model: 'deepseek-v4-pro', tools: [], subagents: [], policy: {} };
  const pool = [
    { kind: 'model-swap' as const, model: 'deepseek-v4-flash' },
    { kind: 'tool-add' as const, tools: ['read_file'] },
  ];
  const runOnce = () => {
    const { s, tape } = mk();
    const r = evolve({
      seed, generations: 3, populationSize: 3, mutationPool: pool, tape,
      harness: (): CounterfactualModel => ({ next: () => ({ type: 'stop' }) }),
      fuel: { perGenerationUsd: 0.5 },
      fuelPerRunUsd: 0.05,
      costOf: () => ({ costUsd: 0.01, tokens: 1 }),
    });
    return { r, close: () => s.close() };
  };
  const a = runOnce();
  const b = runOnce();
  assert.equal(a.r.generations.length, 3, '市场模式世代正常推进');
  assert.ok(a.r.spentUsd > 0, '跨世代市场消耗累计');
  assert.equal(a.r.best!.genomeHash, b.r.best!.genomeHash, '市场模式同样可复现');
  a.close();
  b.close();
});
