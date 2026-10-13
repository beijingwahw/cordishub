/**
 * Demo: 模拟一个 DSH session，验证 CordisHub 完整链路
 *
 * 运行后会：
 *   1. 创建一个 mock Cordis context（不依赖真的 DSH）
 *   2. 安装 Cordishub
 *   3. 模拟一个多 run agent session（包含 system / user / reasoning / tool / subagent）
 *   4. 演示 replay、cost、hub、safety 四个能力
 *   5. 输出 dashboard HTML（可双击打开）
 *
 * 运行：tsx demo/run.ts
 */

import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CordishubService,
  SafetyNet,
  escapeHtml,
  generateSigningKeyPair,
  signManifest,
  verifyManifest,
  diffCapabilities,
  renderCapabilityDiff,
  renderGenome,
  hashGenome,
  loadGenomes,
  verifyFile,
  mintRoot,
  attenuate,
  assertTool,
  cacheTaintCompatible,
  type CounterfactualModel,
  type PluginManifest,
  type SessionEvent,
  type Session,
} from '../src/index.ts';

class MockContext {
  private listeners = new Map<string, Array<(...args: any[]) => void>>();
  private services: Record<string, any> = {};

  on(event: string, handler: (...args: any[]) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(handler);
  }

  off(event: string, handler: (...args: any[]) => void): void {
    const arr = this.listeners.get(event);
    if (arr) {
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  emit(event: string, ...args: any[]): void {
    const arr = this.listeners.get(event) ?? [];
    for (const h of arr) h(...args);
  }

  plugin(svc: any): void {
    // Mock 上 plugin 只把 service 注册到 services map，不触发 install（避免递归）
    if (svc && typeof svc === 'object') {
      const name = svc.constructor?.name?.replace(/Service$/, '').toLowerCase();
      if (name) this.services[name] = svc;
    }
  }

  set(k: string, v: any) {
    this.services[k] = v;
  }

  get(k: string): any {
    return this.services[k];
  }
}

async function main() {
  const outDir = join(process.cwd(), 'demo', 'output');
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const ctx = new MockContext();
  const dbPath = join(outDir, 'cordish.db');
  const cordis = new CordishubService(ctx, {
    dbPath,
    onViolation: 'log',
    budget: { limitUsd: 1.0, reserveEstimateUsd: 0.05 },
  });

  cordis.install();
  ctx.set('cordishub', cordis);

  // ===== 模拟 session #1 =====
  const sessionAId = 'sess-001';
  const sessionA: Session = {
    id: sessionAId,
    startedAt: Date.now(),
    model: 'deepseek-v4-pro',
    totalTokens: 0,
    totalCost: 0,
    meta: { tenant: 'acme-corp', run: 'demo-a' },
  };
  ctx.emit('session/started', sessionA);

  const eventsA: SessionEvent[] = [
    {
      id: 'e1', sessionId: sessionAId, source: 'system', ts: Date.now(), seq: 1,
      payload: { text: 'You are a senior backend engineer. Help them ship clean code.' },
    },
    {
      id: 'e2', sessionId: sessionAId, source: 'user', ts: Date.now() + 10, seq: 2,
      payload: { text: 'Refactor the billing service to be more testable.' },
    },
    {
      id: 'e3', sessionId: sessionAId, source: 'reasoning', ts: Date.now() + 20, seq: 3,
      payload: { text: 'Plan: (1) read current code, (2) identify coupling, (3) propose seam interfaces, (4) write tests first.' },
    },
    {
      id: 'e4', sessionId: sessionAId, source: 'tool', ts: Date.now() + 30, seq: 4,
      toolCallId: 'tc1',
      payload: { tool_name: 'shell', arguments: { cmd: 'ls src/billing' }, result: { stdout: 'invoice.ts\npayment.ts\nrefund.ts' } },
    },
    {
      id: 'e5', sessionId: sessionAId, source: 'reasoning', ts: Date.now() + 40, seq: 5,
      payload: { text: 'Found three files. Most coupling is in invoice.ts. Need to extract a PricingPolicy seam.' },
    },
    {
      id: 'e6', sessionId: sessionAId, source: 'model', ts: Date.now() + 50, seq: 6,
      model: 'deepseek-v4-pro',
      tokens: { prompt: 4200, completion: 850, reasoning: 600, total: 5650, cacheRead: 2200 },
      payload: { text: 'I will:\n1. Create PricingPolicy seam\n2. Extract PaymentGateway interface\n3. Write contract tests first\nLet me check the file structure first.' },
    },
  ];
  for (const ev of eventsA) {
    if (ev.source === 'model') {
      // v0.2：调用前先走预算预授权（reserve），响应后按实际成本结算（settle）
      ctx.emit('model/request', { ...ev, id: `${ev.id}-req`, payload: {} });
      ctx.emit('model/response', ev);
    } else if (ev.source === 'tool') {
      // 拆成 called + result（id 必须不同：append-only 内存索引按 id 去重，
      // 共用 id 会让"结果"行覆盖"调用"行，盒带录制时丢失 tool-call 半边）
      ctx.emit('tool/called', { ...ev, id: `${ev.id}-call`, payload: { tool_name: ev.payload.tool_name, arguments: ev.payload.arguments } });
      ctx.emit('tool/result', { ...ev, id: `${ev.id}-result`, payload: { tool_name: ev.payload.tool_name, result: ev.payload.result } });
    } else ctx.emit('context/injection', ev);
  }

  ctx.emit('session/ended', sessionAId, Date.now());

  // ===== 模拟 session #2 (with violations) =====
  const sessionBId = 'sess-002';
  ctx.emit('session/started', {
    id: sessionBId,
    startedAt: Date.now(),
    model: 'deepseek-v4-pro',
    totalTokens: 0,
    totalCost: 0,
    meta: { tenant: 'beta-corp' },
  } as Session);

  // 设置 safety 策略：tenant beta 只能用 read-only tools
  cordis.safety = new SafetyNet({
    tenant: 'beta-corp',
    toolWhitelist: ['shell', 'read_file'],
  });

  // 故意触发 tool 越权
  ctx.emit('tool/called', {
    id: 'vx', sessionId: sessionBId, source: 'tool', ts: Date.now(), seq: 1,
    toolCallId: 'tc-v',
    payload: { tool_name: 'delete_database', arguments: { table: 'users' } },
  } as SessionEvent);

  ctx.emit('session/ended', sessionBId, Date.now());

  // ===== 演示 1: Cost breakdown =====
  console.log('\n=== COST BREAKDOWN ===');
  const breakdown = cordis.costBreakdown();
  console.log(JSON.stringify(breakdown, null, 2));
  for (const b of breakdown) {
    console.log(`  ${b.id}  ${(b.model ?? '').padEnd(20)}  ${(b.totalTokens ?? 0).toString().padStart(6)} tok  $${(b.totalCost ?? 0).toFixed(4)}`);
  }

  // ===== 演示 1.5: Budget Ledger（v0.2 预算预授权） =====
  console.log('\n=== BUDGET LEDGER (v0.2 pre-auth) ===');
  if (cordis.budget) {
    const snap = cordis.budget.snapshot();
    console.log(`  limit=$${snap.limitUsd.toFixed(2)}  spent=$${snap.spentUsd.toFixed(4)}  reserved=$${snap.reservedUsd.toFixed(4)}  available=$${snap.availableUsd.toFixed(4)}`);
    console.log(`  模型调用前 reserve($0.05) → 响应后按实际成本 settle → 剩余额度即时释放`);
  }

  // ===== 演示 2: Replay reconstruct =====
  console.log('\n=== REPLAY STATE for sess-001 (full) ===');
  const events = cordis.storage.getEvents(sessionAId);
  console.log(`  events count: ${events.length}`);
  console.log(`  eventsFile rows size: ${(cordis.storage as any).eventsFile.rows.size}`);
  console.log(`  eventsFile keys: ${[...(cordis.storage as any).eventsFile.rows.keys()].join(', ')}`);
  console.log(`  eventsFile values[0].sessionId: ${[...(cordis.storage as any).eventsFile.rows.values()][0]?.sessionId}`);
  for (const ev of events) console.log(`    #${ev.seq} ${ev.source} ${ev.payload?.text ? `"${(ev.payload.text as string).slice(0, 50)}"` : ''} tokens=${JSON.stringify(ev.tokens)}`);
  const state = cordis.reconstruct(sessionAId);
  console.log(`  systemPrompt (first 80): ${state.systemPrompt.slice(0, 80)}...`);
  console.log(`  userInputs: ${state.userInputs.length}`);
  console.log(`  toolCalls: ${state.toolCalls.map((t) => t.name).join(', ')}`);
  console.log(`  totalTokens: ${state.totalTokens}`);

  // ===== 演示 3: Checkpoint + Fork =====
  console.log('\n=== CHECKPOINT + FORK from seq=3 ===');
  const cp = cordis.checkpoint(sessionAId, 3, 'before replan fork');
  console.log(`  checkpoint: seq=${cp?.seq} eventId=${cp?.eventId} message="${cp?.message}"`);
  const forked = cordis.fork(sessionAId, 3, 'sess-001-fork', { label: 'replan' });
  console.log(`  forked session: ${forked.id}, model=${forked.model}, totalTokens=${forked.totalTokens}`);
  console.log(`  checkpoints on ${sessionAId}: ${cordis.storage.checkpoints(sessionAId).length}`);

  // ===== 演示 3.5: Genome（G0 会话可遗传化：提取 → 变异 → 育种） =====
  console.log('\n=== GENOME (G0 extract → mutate → breed) ===');
  const childGenome = cordis.breed(sessionAId, [
    { kind: 'model-swap', model: 'deepseek-v4-flash' },
    { kind: 'tool-add', tools: ['read_file'] },
    { kind: 'policy', patch: { maxCostUsd: 0.5 } },
  ], { name: 'billing-refactorer' });
  if (childGenome) {
    for (const line of renderGenome(childGenome)) console.log(`  ${line}`);
    const fitness = cordis.genomeFitness(hashGenome(childGenome));
    console.log(`  fitness: sessions=${fitness.sessions} tokens=${fitness.totalTokens} cost=$${fitness.totalCost.toFixed(4)}`);
  }

  // ===== 演示 4: Diff two sessions at same seq range =====
  console.log('\n=== DIFF sess-001 vs sess-001-fork at [0, 3] ===');
  const diff = cordis.diff(sessionAId, 'sess-001-fork', { fromSeq: 0, toSeq: 3 });
  console.log(`  only in A: ${diff.onlyInA.length}, only in B: ${diff.onlyInB.length}, different: ${diff.different.length}`);

  // ===== 演示 5: Hub search =====
  console.log('\n=== HUB SEARCH ===');
  const proSearch = cordis.hub.search({ query: 'review' });
  console.log(`  query="review" → ${proSearch.length} hits:`);
  for (const p of proSearch) {
    console.log(`    [${p.stars.toString().padStart(5)}★] ${p.fullName} — ${p.description.slice(0, 60)}`);
  }
  console.log(`\n  query="mcp" → ${cordis.hub.search({ query: 'mcp' }).length} hits`);
  console.log(`  onlyOfficial=true → ${cordis.hub.search({ official: true }).length} hits`);

  // ===== 演示 5.5: Signed Manifest（v0.2 供应链防线） =====
  console.log('\n=== SIGNED MANIFEST (v0.2 supply chain) ===');
  const kp = generateSigningKeyPair();
  const manifest: PluginManifest = {
    name: 'community/dsh-plugin-cost-guard',
    version: '0.2.0',
    capabilities: ['fs.read', 'fs.write', 'shell'],
    contentHash: 'ab'.repeat(32),
    tarball: 'https://example.com/cost-guard-0.2.0.tgz',
  };
  const sig = signManifest(manifest, kp.privateKey);
  console.log(`  signature: ${sig.slice(0, 32)}…`);
  console.log(`  verify(original):      ${verifyManifest(manifest, sig, kp.publicKey)}`);
  console.log(`  verify(tampered hash): ${verifyManifest({ ...manifest, contentHash: 'cd'.repeat(32) }, sig, kp.publicKey)}`);
  console.log(`  capability diff 0.1.0 → 0.2.0:`);
  for (const line of renderCapabilityDiff(manifest.name, '0.1.0', '0.2.0', diffCapabilities(['fs.read', 'net'], manifest.capabilities))) {
    console.log(`  ${line}`);
  }

  // ===== 演示 6: Safety violations =====
  console.log('\n=== SAFETY HISTORY ===');
  for (const v of cordis.safetyHistory()) {
    console.log(`  [${v.severity}] ${v.kind}: ${v.detail}`);
  }

  // ===== 演示 8: Full-text search =====
  console.log('\n=== FULL-TEXT SEARCH ===');
  const hits = cordis.search('billing');
  for (const h of hits) {
    console.log(`  ${h.sessionId} (${h.source}): ${h.snippet}`);
  }

  // ===== 演示 9: Chain Audit（L0 哈希链防篡改） =====
  console.log('\n=== CHAIN AUDIT (L0 tamper-evidence) ===');
  cordis.storage.sealNow();
  for (const r of cordis.audit()) {
    const name = r.file.split(/[\\/]/).pop();
    console.log(`  ${r.ok ? '✓' : '✗'} ${name}  seals=${r.seals} rows=${r.rows} head=${r.head.slice(0, 12)}…${r.error ? `  ${r.error}` : ''}`);
  }
  // 篡改演示：在副本上改一个字符，链验证必须失败
  const eventsPath = cordis.audit().find((r) => r.file.endsWith('.events.jsonl'))!.file;
  const tamperedPath = join(outDir, 'tampered.events.jsonl');
  writeFileSync(tamperedPath, readFileSync(eventsPath, 'utf8').replace('billing', 'Billing'));
  const bad = verifyFile(tamperedPath);
  console.log(`  篡改副本（billing→Billing）验证: ok=${bad.ok}  ${bad.error ?? ''}`);
  rmSync(tamperedPath);

  // ===== 演示 10: Capability（ocap 能力衰减） =====
  console.log('\n=== CAPABILITY (ocap attenuation) ===');
  const rootCap = mintRoot({ tenant: 'acme', tools: ['shell', 'read_file', 'http_get'], maxSpendUsd: 1 });
  const subCap = attenuate(rootCap, { tools: ['shell', 'read_file'], maxSpendUsd: 0.2 });
  console.log(`  root: ${rootCap.tag}  tools=[${rootCap.tools.join(', ')}]  depth=${rootCap.depth}`);
  console.log(`  sub:  ${subCap.tag}  tools=[${subCap.tools.join(', ')}]  depth=${subCap.depth}  parent=${subCap.parentTag}`);
  try {
    attenuate(rootCap, { tools: ['shell', 'net'] });
  } catch (e) {
    console.log(`  扩权尝试被拒: ${(e as Error).message}`);
  }
  try {
    assertTool(subCap, 'http_get');
  } catch (e) {
    console.log(`  子令牌访问未授予工具被拒: ${(e as Error).message}`);
  }

  // ===== 演示 11: Cassette（L1 确定性回放：故障注入 + 因果二分） =====
  console.log('\n=== CASSETTE (L1 deterministic replay) ===');
  const tape = cordis.recordTape(sessionAId);
  if (tape) {
    const kinds: Record<string, number> = {};
    for (const e of tape.entries) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    console.log(`  tape: ${tape.entries.length} entries ${JSON.stringify(kinds)}`);
    console.log(`  determinism: tools=${tape.determinism.toolsRecorded} sampling=${tape.determinism.samplingRecorded}`);

    // 故障注入：第 0 个工具响应换成错误，脚本模型遇错即停 → 立刻分叉
    const reactive: CounterfactualModel = {
      next: (st) => {
        const last = st.toolCalls[st.toolCalls.length - 1];
        if (last?.error) return { type: 'stop' };
        if (st.toolCalls.length === 0) return { type: 'tool', tool: 'shell', args: { cmd: 'ls src/billing' } };
        return { type: 'say', text: 'All good.' };
      },
    };
    const cf = cordis.counterfactual(sessionAId, { model: reactive, fault: { atToolIndex: 0, error: 'disk failure' } });
    if (cf) {
      console.log(`  fault@tool#0 → steps=${cf.steps.length} divergedAtStep=${cf.divergedAtStep ?? '—'} stop=${cf.stopReason}`);
      console.log(`  注入错误对模型可见: error="${cf.endState.toolCalls[0]?.error}"`);
    }

    // 因果二分：找 "refund 出现在工具输出里" 最早发生的 seq
    const bis = cordis.bisect(sessionAId, (st) => st.toolCalls.some((t) => (t.result as { stdout?: string } | undefined)?.stdout?.includes('refund')));
    console.log(`  bisect "refund 泄漏" → firstBadSeq=${bis.seq}（仅 ${bis.checked} 次状态重构）`);

    // ===== 演示 12: Reactor（G1 变体跑批：燃料闸门 + 适应度选择） =====
    console.log('\n=== REACTOR (G1 variant batch under fuel gate) ===');
    const recordedActions: import('../src/cassette.ts').CfAction[] = [];
    for (const e of tape.entries) {
      if (e.kind === 'tool-call') recordedActions.push({ type: 'tool', tool: e.tool, args: e.args });
      else if (e.kind === 'model') recordedActions.push({ type: 'say', text: e.text });
    }
    const reactorReport = cordis.reactor(sessionAId, {
      variants: [
        { name: 'flash-fast', mutations: [{ kind: 'model-swap', model: 'deepseek-v4-flash' }] },
        { name: 'pro-careful', mutations: [{ kind: 'tool-add', tools: ['read_file'] }] },
        { name: 'pro-drifter', mutations: [{ kind: 'prompt-append', text: 'Explore aggressively.' }] },
        { name: 'no-fuel', mutations: [{ kind: 'model-swap', model: 'deepseek-v4-flash' }] },
      ],
      harness: (g) => ({
        next: (_st: unknown, step: number) => {
          if (g.systemPrompt.includes('Explore aggressively')) {
            return step === 0 ? { type: 'tool' as const, tool: 'shell', args: { cmd: 'find / -name secret' } } : { type: 'stop' as const };
          }
          return recordedActions[step] ?? { type: 'stop' as const };
        },
      }),
      costOf: () => ({ costUsd: 0.02, tokens: 1000 }),
      budget: { limitUsd: 0.07, fuelPerRunUsd: 0.02 },
      save: true,
    });
    if (reactorReport) {
      for (const r of reactorReport.runs) {
        const mark = r.rejected ? '⛔' : ' ';
        const fit = r.fitness === -Infinity ? '—    ' : r.fitness.toFixed(3);
        const div = r.result ? (r.result.divergedAtStep ?? '—') : '—';
        console.log(`  ${mark} ${r.variant.padEnd(13)} fitness=${fit}  cost=$${r.costUsd.toFixed(4)}  steps=${r.result?.steps.length ?? 0}  diverged=${div}${r.rejected ? '  ← 燃料不足，跑批前被拒' : ''}`);
      }
      console.log(`  best: ${reactorReport.best?.variant} [${reactorReport.best?.genomeHash.slice(0, 12)}]（保真优先；并列时取先者——真实场景按模型费率估成本，flash 更便宜）`);
      console.log(`  spent=$${reactorReport.spentUsd.toFixed(4)}  available=$${reactorReport.availableUsd.toFixed(4)}  exhausted=${reactorReport.budgetExhausted}`);
      console.log(`  基因库现有 ${loadGenomes(cordis.storage).length} 个基因组（种子 + 全部变体谱系）`);
    }

    // ===== 演示 13: Taint（信息流检查：传播 / 溯源 / 清洗 / 缓存兼容） =====
    console.log('\n=== TAINT (information-flow check) ===');
    const taintReport = cordis.taintScan(sessionAId, {
      taintOfEvent: (source, p) =>
        source === 'context' && String(p['text'] ?? '').includes('billing') ? ['tenant:acme'] : [],
      taintOfToolResult: (tool, result) =>
        String((result as { stdout?: string })?.stdout ?? '').includes('refund') ? ['pii'] : [],
      sanitize: (tool) => /redact|sanitiz|scrub/i.test(tool),
      forbiddenInOutput: ['secret'],
    });
    if (taintReport) {
      for (const t of taintReport.timeline.filter((x) => x.added.length > 0 || x.removed.length > 0)) {
        console.log(`    seq#${t.seq}  +[${t.added.join(', ') || '—'}]  -[${t.removed.join(', ') || '—'}]  → active=[${t.active.join(', ') || '—'}]`);
      }
      console.log(`  violations=${taintReport.violations.length}  final=[${taintReport.finalActive.join(', ') || '—'}]`);
      console.log(`  prompt-cache 同租户复用: ${cacheTaintCompatible(['tenant:acme'], ['tenant:acme', 'pii'])}（子集规则放行）`);
      console.log(`  prompt-cache 跨租户复用: ${cacheTaintCompatible(['tenant:acme'], ['tenant:beta-corp'])}（强制 MISS）`);
    }
  }

  // ===== 输出 dashboard HTML =====
  const dashboardHtml = renderDashboard({
    sessions: cordis.recentSessions(50),
    breakdown,
    safetyHistory: cordis.safetyHistory(),
    hubHits: cordis.hub.search({ limit: 20 }),
    state,
    forked,
    diff,
    eventsA,
  });
  const dashPath = join(outDir, 'dashboard.html');
  writeFileSync(dashPath, dashboardHtml);
  console.log(`\n=== Dashboard written to: ${dashPath} ===`);
  console.log('Open it in your browser to see the full UI.');

  cordis.dispose();
}

function renderDashboard(data: any): string {
  const esc = (x: unknown) => escapeHtml(String(x ?? ''));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>CordisHub · DSH Workstation</title>
<style>
  :root {
    --bg: #0b0d12; --bg2: #11151c; --bg3: #1a1f2a;
    --fg: #e6e9ef; --fg2: #9aa3b2; --fg3: #6b7384;
    --accent: #7c5cff; --accent2: #4cb8ff; --accent4: #00d1b2;
    --warn: #ffb86b; --err: #ff5e7e;
    --border: #2a2f3a;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", Arial; background: var(--bg); color: var(--fg); font-size: 13px; line-height: 1.5; }
  header { padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--bg2); display: flex; align-items: center; gap: 14px; }
  header .brand { font-weight: 600; font-size: 15px; background: linear-gradient(120deg, var(--accent), var(--accent2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  header .badge { padding: 2px 8px; border-radius: 4px; background: var(--bg3); color: var(--fg2); font-size: 11px; }
  main { padding: 24px; max-width: 1400px; margin: 0 auto; }
  h2 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg2); margin: 28px 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .stat { font-size: 22px; font-weight: 600; margin: 4px 0; }
  .stat small { font-size: 11px; color: var(--fg3); font-weight: 400; margin-left: 6px; }
  .label { color: var(--fg2); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; background: var(--bg3); color: var(--fg2); font-size: 11px; margin-right: 4px; }
  .pill.warn { background: rgba(255,184,107,0.15); color: var(--warn); }
  .pill.err { background: rgba(255,94,126,0.15); color: var(--err); }
  .pill.ok { background: rgba(0,209,178,0.15); color: var(--accent4); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--fg2); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  mark { background: rgba(124,92,255,0.3); color: var(--accent); padding: 0 2px; border-radius: 2px; }
  .timeline { border-left: 2px solid var(--border); padding-left: 16px; }
  .timeline-item { position: relative; padding: 6px 0; }
  .timeline-item:before { content: ''; position: absolute; left: -22px; top: 12px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
  .timeline-item.tool:before { background: var(--accent2); }
  .timeline-item.reasoning:before { background: var(--accent4); }
  .timeline-item.user:before { background: var(--warn); }
  .timeline-item.system:before { background: var(--fg3); }
  .timeline-item .ts { color: var(--fg3); font-size: 11px; margin-right: 8px; }
  .timeline-item .src { color: var(--fg2); font-size: 11px; text-transform: uppercase; }
  pre { background: var(--bg3); border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 12px; }
  .footer { text-align: center; color: var(--fg3); padding: 30px 0; font-size: 11px; }
</style>
</head>
<body>
<header>
  <div class="brand">CordisHub</div>
  <span class="badge">DSH Workstation</span>
  <span class="badge">v0.10.0</span>
  <span class="badge" style="margin-left:auto">everything-is-a-plugin</span>
</header>
<main>
  <h2>· Live Cost Console</h2>
  <div class="grid">
    <div class="card">
      <div class="label">Sessions</div>
      <div class="stat">${data.breakdown.length}<small>runs</small></div>
    </div>
    <div class="card">
      <div class="label">Total Tokens</div>
      <div class="stat">${data.breakdown.reduce((s: number, b: any) => s + b.totalTokens, 0).toLocaleString()}<small>tokens</small></div>
    </div>
    <div class="card">
      <div class="label">Total Spend</div>
      <div class="stat">$${data.breakdown.reduce((s: number, b: any) => s + b.totalCost, 0).toFixed(4)}</div>
    </div>
    <div class="card">
      <div class="label">Safety Violations</div>
      <div class="stat">${data.safetyHistory.length}<small>blocked</small></div>
    </div>
  </div>

  <h2>· Cost Breakdown by Session</h2>
  <div class="card">
    <table>
      <thead>
        <tr><th>Session</th><th>Model</th><th class="num">Tokens</th><th class="num">Cost (USD)</th></tr>
      </thead>
      <tbody>
        ${data.breakdown.map((b: any) => `
        <tr>
          <td><code>${esc(b.id)}</code></td>
          <td>${esc(b.model)}</td>
          <td class="num">${b.totalTokens.toLocaleString()}</td>
          <td class="num">$${b.totalCost.toFixed(4)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>

  <h2>· Replay Lab · Timeline (sess-001)</h2>
  <div class="card">
    <div class="timeline">
      ${data.eventsA.map((ev: any) => `
      <div class="timeline-item ${ev.source}">
        <span class="ts">#${ev.seq}</span>
        <span class="src">${ev.source}</span>
        ${esc(ev.payload.text || ev.payload.tool_name || (ev.payload.arguments ? JSON.stringify(ev.payload.arguments) : ''))}
        ${ev.tokens ? `<span class="pill">${ev.tokens.total.toLocaleString()} tok</span>` : ''}
      </div>`).join('')}
    </div>
  </div>

  <h2>· Fork & Replay</h2>
  <div class="grid-2">
    <div class="card">
      <div class="label">Forked Session</div>
      <pre>${esc(JSON.stringify({ id: data.forked.id, model: data.forked.model, totalTokens: data.forked.totalTokens, label: data.forked.meta?.label }, null, 2))}</pre>
    </div>
    <div class="card">
      <div class="label">Diff (orig vs fork) at [0,3]</div>
      <pre>${esc(JSON.stringify({ onlyInA: data.diff.onlyInA.length, onlyInB: data.diff.onlyInB.length, different: data.diff.different.length }, null, 2))}</pre>
    </div>
  </div>

  <h2>· Safety Net · Live Violations</h2>
  <div class="card">
    <table>
      <thead>
        <tr><th>Kind</th><th>Severity</th><th>Detail</th><th class="num">ts</th></tr>
      </thead>
      <tbody>
        ${data.safetyHistory.length === 0
          ? '<tr><td colspan="4" style="text-align:center;color:var(--fg3);padding:24px">No violations. ✓</td></tr>'
          : data.safetyHistory.map((v: any) => `
        <tr>
          <td><code>${esc(v.kind)}</code></td>
          <td><span class="pill ${v.severity === 'block' ? 'err' : 'warn'}">${esc(v.severity)}</span></td>
          <td>${esc(v.detail)}</td>
          <td class="num">${new Date(v.ts).toISOString().slice(11, 19)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>

  <h2>· Plugin Hub · Top Plugins</h2>
  <div class="card">
    <table>
      <thead>
        <tr><th>Plugin</th><th>Description</th><th class="num">Stars</th><th>Tags</th></tr>
      </thead>
      <tbody>
        ${data.hubHits.map((p: any) => `
        <tr>
          <td><code>${esc(p.fullName)}</code>${p.official ? ' <span class="pill ok">official</span>' : ''}</td>
          <td>${esc(p.description)}</td>
          <td class="num">${p.stars.toLocaleString()}</td>
          <td>${p.tags.map((t: string) => `<span class="pill">${esc(t)}</span>`).join('')}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>

  <div class="footer">CordisHub · everything is a plugin · MIT</div>
</main>
</body>
</html>`;
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});