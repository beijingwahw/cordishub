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

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  CordishubService,
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
    if (ev.source === 'model') ctx.emit('model/response', ev);
    else if (ev.source === 'tool') {
      // 拆成 called + result
      ctx.emit('tool/called', { ...ev, payload: { tool_name: ev.payload.tool_name, arguments: ev.payload.arguments } });
      ctx.emit('tool/result', { ...ev, payload: { tool_name: ev.payload.tool_name, result: ev.payload.result } });
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
  cordis.safety = new (await import('../src/safety.ts')).SafetyNet({
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

  // ===== 演示 3: Fork =====
  console.log('\n=== FORK from seq=3 ===');
  const forked = cordis.fork(sessionAId, 3, 'sess-001-fork', { label: 'replan' });
  console.log(`  forked session: ${forked.id}, model=${forked.model}, totalTokens=${forked.totalTokens}`);

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

  // ===== 演示 6: Safety violations =====
  console.log('\n=== SAFETY HISTORY ===');
  for (const v of cordis.safetyHistory()) {
    console.log(`  [${v.severity}] ${v.kind}: ${v.detail}`);
  }

  // ===== 演示 7: Full-text search =====
  console.log('\n=== FULL-TEXT SEARCH ===');
  const hits = cordis.search('billing');
  for (const h of hits) {
    console.log(`  ${h.sessionId} (${h.source}): ${h.snippet}`);
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
  <span class="badge">v0.1.0</span>
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
      <div class="stat">${data.breakdown.reduce((s: number, b: any) => s + b.total_tokens, 0).toLocaleString()}<small>tokens</small></div>
    </div>
    <div class="card">
      <div class="label">Total Spend</div>
      <div class="stat">$${data.breakdown.reduce((s: number, b: any) => s + b.total_cost, 0).toFixed(4)}</div>
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
          <td><code>${b.id}</code></td>
          <td>${b.model}</td>
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
        ${ev.payload.text || ev.payload.tool_name || (ev.payload.arguments ? JSON.stringify(ev.payload.arguments) : '')}
        ${ev.tokens ? `<span class="pill">${ev.tokens.total.toLocaleString()} tok</span>` : ''}
      </div>`).join('')}
    </div>
  </div>

  <h2>· Fork & Replay</h2>
  <div class="grid-2">
    <div class="card">
      <div class="label">Forked Session</div>
      <pre>${JSON.stringify({ id: data.forked.id, model: data.forked.model, totalTokens: data.forked.totalTokens, label: data.forked.meta?.label }, null, 2)}</pre>
    </div>
    <div class="card">
      <div class="label">Diff (orig vs fork) at [0,3]</div>
      <pre>${JSON.stringify({ onlyInA: data.diff.onlyInA.length, onlyInB: data.diff.onlyInB.length, different: data.diff.different.length }, null, 2)}</pre>
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
          <td><code>${v.kind}</code></td>
          <td><span class="pill ${v.severity === 'block' ? 'err' : 'warn'}">${v.severity}</span></td>
          <td>${v.detail}</td>
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
          <td><code>${p.fullName}</code>${p.official ? ' <span class="pill ok">official</span>' : ''}</td>
          <td>${p.description}</td>
          <td class="num">${p.stars.toLocaleString()}</td>
          <td>${p.tags.map((t: string) => `<span class="pill">${t}</span>`).join('')}</td>
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