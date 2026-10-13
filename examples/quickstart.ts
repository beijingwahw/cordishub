/**
 * 快速上手（5 分钟跑起来）
 *
 * 这是 CordisHub 的最小可运行示例：
 *   1. 创建一个 CordisHub service
 *   2. 模拟一个 DeepSeek Harness session 跑起来
 *   3. 触发一个安全违规（演示 safety net 怎么拦）
 *   4. 输出 cost / replay / safety / hub / dashboard
 *
 * 运行：
 *   node --experimental-strip-types --no-warnings examples/quickstart.ts
 */
import { CordishubService } from '../packages/core/src/service.ts'
import { Storage } from '../packages/core/src/storage.ts'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(__dirname, 'output')
fs.mkdirSync(OUTPUT_DIR, { recursive: true })

// === 1. 准备 CordisHub service ===
// 模拟一个 DSH Cordis 上下文：支持事件总线，让 CordisHub 的 listener 能收到事件。
const listeners = new Map<string, Array<(...args: any[]) => void>>()
const ctx: any = {
  on: (e: string, h: (...args: any[]) => void) => {
    if (!listeners.has(e)) listeners.set(e, [])
    listeners.get(e)!.push(h)
  },
  off: (e: string, h: (...args: any[]) => void) => {
    listeners.get(e)?.splice(listeners.get(e)?.indexOf(h) ?? 0, 1)
  },
  emit: (e: string, ...args: any[]) => {
    for (const h of listeners.get(e) ?? []) h(...args)
  },
  plugin: () => {},
  set: () => {},
  get: () => undefined,
}
const svc = new CordishubService(ctx, {
  dbPath: path.join(OUTPUT_DIR, 'cordishub.jsonl'),
  capabilities: { hub: true, replay: true, cost: true, safety: true },
  safetyPolicy: {
    tenant: 'acme',
    toolWhitelist: ['shell', 'read_file', 'http_get'],
    maxCostUsd: 10.0,
  },
  onViolation: 'warn',
})
svc.install()

console.log('--- step 1 · created CordisHub service + persist storage\n')
console.log(`storage path: ${OUTPUT_DIR}/cordishub.jsonl\n`)

// === 2. 模拟一个 DSH session ===
// DSH 自己会在 ctx 上 emit 几个事件，CordisHub 自动捕获：
//   session/started → 记录 session
//   model/response  → 计算 cost
//   tool/called      → safety net 检查工具是否在白名单
//   session/ended   → 关闭

console.log('--- step 2 · 模拟一个 acme 租户的 session\n')

const tenant = 'acme'
const sessionId = 'sess-acme-001'

// 1) session 开始
ctx.emit('session/started', {
  id: sessionId,
  startedAt: Date.now(),
  model: 'deepseek-v4-pro',
  totalTokens: 0,
  totalCost: 0,
  meta: { tenant },
})

// 2) model 返回
ctx.emit('model/response', {
  id: 'ev-1',
  sessionId,
  source: 'model',
  ts: Date.now(),
  seq: 1,
  model: 'deepseek-v4-pro',
  tokens: { prompt: 1200, completion: 320, reasoning: 150, total: 1670, cacheRead: 700 },
  payload: { text: 'Hi acme team, what should I work on first?' },
})

// 3) 调一个合法工具（payload 按 schema 用 arguments / result）
ctx.emit('tool/called', {
  id: 'ev-2',
  sessionId,
  source: 'tool',
  ts: Date.now(),
  seq: 2,
  payload: { tool_name: 'shell', arguments: { cmd: 'ls -la' } },
  meta: { tenant },
})
ctx.emit('tool/result', {
  id: 'ev-3',
  sessionId,
  source: 'tool',
  ts: Date.now(),
  seq: 3,
  payload: { tool_name: 'shell', result: { stdout: 'LICENSE\nREADME.md\nsrc/\n' } },
})

// === 3. 触发一个安全违规（演示 safety net） ===
console.log('--- step 3 · 触发安全违规（beta-corp 试图用 delete_database）\n')

ctx.emit('session/started', {
  id: 'sess-beta-002',
  startedAt: Date.now(),
  model: 'deepseek-v4-pro',
  totalTokens: 0,
  totalCost: 0,
  meta: { tenant: 'beta-corp' },
})

ctx.emit('tool/called', {
  id: 'ev-4',
  sessionId: 'sess-beta-002',
  source: 'tool',
  ts: Date.now(),
  seq: 1,
  payload: { tool_name: 'delete_database', args: { table: 'users' } },
  meta: { tenant: 'beta-corp' },
})

// === 4. 关闭 sessions ===
// 标准两参形态：(sessionId, endedAt)。service 也兼容对象形态，但示例按规范写。
ctx.emit('session/ended', sessionId, Date.now())
ctx.emit('session/ended', 'sess-beta-002', Date.now())

// === 5. 输出所有功能的结果 ===
console.log('--- step 4 · 查看 CordisHub 输出\n')

console.log('[COST BREAKDOWN]')
for (const r of svc.costBreakdown()) {
  console.log(`  ${r.id.padEnd(20)} ${r.model.padEnd(20)} ${r.totalTokens.toLocaleString().padStart(8)} tok  $${r.totalCost.toFixed(4)}`)
}
console.log()

console.log('[SAFETY HISTORY]')
const safetyEvents = svc.safetyHistory()
if (safetyEvents.length === 0) {
  console.log('  ✓ 没有违规')
} else {
  for (const v of safetyEvents) {
    console.log(`  [${v.severity}] ${v.kind}: ${v.detail}`)
  }
}
console.log()

console.log('[REPLAY sess-acme-001]')
const state = svc.replaySession(sessionId)
console.log(`  events: ${state.history.length}`)
console.log(`  tools: ${state.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args ?? {}).slice(0, 30)})`).join(', ')}`)
console.log(`  total tokens: ${state.totalTokens.toLocaleString()}`)
console.log()

console.log('[HUB SEARCH review]')
for (const h of svc.searchHub('review', { limit: 3 })) {
  console.log(`  ${h.stars.toLocaleString()}★  ${h.fullName}  — ${h.description}`)
}
console.log()

// === 6. 写一个 HTML dashboard ===
const dashboardPath = path.join(OUTPUT_DIR, 'dashboard.html')
fs.writeFileSync(dashboardPath, svc.renderDashboard(), 'utf8')
console.log(`[DASHBOARD] ${dashboardPath}`)

// === 7. 内核巡礼（v0.3-v0.8 能力一览） ===
console.log('\n[KERNEL TOUR]')

// L0 · 哈希链审计
svc.sealNow()
for (const r of svc.audit()) {
  console.log(`  ${r.ok ? '✓' : '✗'} chain ${r.file.split(/[\\/]/).pop()} seals=${r.seals} head=${r.head.slice(0, 10)}…`)
}

// G0 · 基因型
const genome = svc.extractGenome(sessionId)
if (genome) {
  console.log(`  genome: model=${genome.model} tools=[${genome.tools.join(', ')}] prompt="${genome.systemPrompt.slice(0, 36)}…"`)
}

// L1 · 确定性证书（注入确定性 stop 模型 ×3 次重放）
const cert = svc.certifyTape(sessionId, { model: { next: () => ({ type: 'stop' }) }, stabilityRuns: 3 })
if (cert) {
  console.log(`  cassette: level=${cert.level} replayStable=${cert.replayStable}（×${cert.runsCompared} 次）`)
}

// v0.7 · 污点扫描（关键词策略）
const taint = svc.taintScan(sessionId, {
  taintOfToolResult: (_tool, result) => (String((result as { stdout?: string })?.stdout ?? '').includes('LICENSE') ? ['repo-meta'] : []),
})
if (taint) {
  console.log(`  taint: active=[${taint.finalActive.join(', ')}] violations=${taint.violations.length}`)
}

svc.dispose()
console.log('\n✓ CordisHub Quickstart 完成。  接下来：`cordishub serve` 起 JSON-RPC 内核；`cordishub record-demo` 录制演示会话。')