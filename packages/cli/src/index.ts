/**
 * @cordishub/cli · 主入口
 *
 * 设计哲学：零依赖终端 CLI —— 不拉 commander/yargs/inquirer，只用 process.argv
 * 这样 CLI 是个 100% standalone 的 single-binary 体验，启动 < 80ms。
 *
 * 用法：
 *   cordishub hub <search|install|info>
 *   cordishub replay <session-id> [--at N]
 *   cordishub fork <session-id> --at <seq>
 *   cordishub cost [--session <id>] [--json]
 *   cordishub search <query> [--limit N]
 *   cordishub safety review [--limit N]
 *   cordishub dashboard [--output <path>]
 *   cordishub tui
 *   cordishub --help
 */
import { CordishubService } from '../../core/src/service.ts'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

// --------- ANSI 颜色（终端党刚需） ---------
const isTTY = !!process.stdout.isTTY
const c = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  blue: isTTY ? '\x1b[34m' : '',
  magenta: isTTY ? '\x1b[35m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  gray: isTTY ? '\x1b[90m' : '',
}

// --------- 简易 args 解析（不依赖 commander） ---------
type Argv = Record<string, string | boolean | string[]>
function parseArgs(argv: string[]): { cmd: string[]; flags: Argv; rest: string[] } {
  const cmd: string[] = []
  const flags: Argv = {}
  const rest: string[] = []
  let inCmd = true
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      inCmd = false
      const k = a.slice(2)
      if (k.includes('=')) {
        const [key, ...vals] = k.split('=')
        flags[key] = vals.join('=')
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags[k] = next
          i++
        } else {
          flags[k] = true
        }
      }
    } else if (inCmd) {
      cmd.push(a)
    } else {
      rest.push(a)
    }
  }
  return { cmd, flags, rest }
}

// --------- 简易 Help / Banner ---------
const HELP = `
${c.cyan}${c.bold}CordisHub CLI${c.reset} ${c.dim}v0.1.0${c.reset}
${c.dim}DeepSeek · 一站式工作台 / 插件市场 / 会话回放 / 成本仪表盘${c.reset}

${c.bold}用法${c.reset}:
  ${c.green}cordishub hub${c.reset}    <query>                  搜插件
  ${c.green}cordishub replay${c.reset}  <session-id> [--at N]    终端回放
  ${c.green}cordishub fork${c.reset}    <session-id> --at N     fork 一个 session
  ${c.green}cordishub cost${c.reset}    [--session ID] [--json]  成本仪表盘
  ${c.green}cordishub search${c.reset}  <query> [--limit N]      跨 session 全文搜索
  ${c.green}cordishub safety review${c.reset}                     安全审计
  ${c.green}cordishub dashboard${c.reset} [--output PATH]        生成 HTML 仪表盘
  ${c.green}cordishub tui${c.reset}                              终端交互 UI
  ${c.green}cordishub --help${c.reset}                           显示帮助

${c.bold}示例${c.reset}:
  ${c.dim}$${c.reset} cordishub hub "review"
  ${c.dim}$${c.reset} cordishub replay sess-001 --at 4
  ${c.dim}$${c.reset} cordishub cost --session sess-001 --json
  ${c.dim}$${c.reset} cordishub search "billing refactor"

${c.dim}DSH 内嵌时：${c.reset} ${c.cyan}cordishub.apply(ctx)${c.reset} 让 DSH 加载 CordisHub
`

function printHelp(): void {
  console.log(HELP)
}

function banner(): void {
  console.log(`${c.cyan}${c.bold}CordisHub${c.reset} ${c.dim}v0.1.0${c.reset} · DeepSeek 工作台`)
}

// --------- 共享：建立 storage <sessionId> ---------
function defaultDbPath(): string {
  const xdg = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share')
  return path.join(xdg, 'cordishub', 'cordishub.jsonl')
}

async function loadCore(dbPath?: string): Promise<CordishubService> {
  // Mock 上下文：CLI 不在 DSH 内运行，但要让 service 能初始化、跑。
  // 关键：ctx.set/get 引用独立对象，杜绝在 install 时递归。
  const ctxStore: Record<string, unknown> = {}
  const ctx = {
    on: () => {},
    off: () => {},
    emit: () => {},
    plugin: () => {},
    set: (k: string, v: unknown) => { ctxStore[k] = v },
    get: (k: string) => ctxStore[k],
  } as any
  const svc = new CordishubService(ctx, { dbPath: dbPath ?? defaultDbPath() })
  // 完整走 install：attachListeners 是 noop、hub.ingest 会载入 demo 数据
  svc.install()
  return svc
}

// --------- 子命令实现 ---------
async function cmdHub(core: CordishubService, query: string, flags: Argv): Promise<void> {
  const onlyOfficial = !!flags.official
  const limit = Number(flags.limit ?? 12)
  banner()
  console.log(`${c.dim}query:${c.reset} ${query} ${c.dim}(onlyOfficial=${onlyOfficial}, limit=${limit})${c.reset}\n`)
  const hits = core.searchHub(query, { onlyOfficial, limit })
  if (hits.length === 0) {
    console.log(`${c.yellow}没有找到匹配的插件${c.reset}`)
    return
  }
  for (const h of hits) {
    const star = `${(h.stars ?? 0).toLocaleString()}★`
    const tag = h.official ? `${c.green}官方${c.reset}` : `${c.gray}社区${c.reset}`
    console.log(`  ${c.cyan}${star.padEnd(10)}${c.reset} ${tag}  ${c.bold}${h.fullName ?? h.full_name ?? ''}${c.reset}`)
    console.log(`  ${' '.repeat(10)} ${c.dim}${h.description ?? ''}${c.reset}`)
    if (h.tags?.length) {
      console.log(`  ${' '.repeat(10)} ${c.magenta}${h.tags.map((t: string) => `#${t}`).join(' ')}${c.reset}`)
    }
    console.log()
  }
}

async function cmdReplay(core: CordishubService, sessionId: string, flags: Argv): Promise<void> {
  banner()
  const at = flags.at !== undefined ? Number(flags.at) : undefined
  const state = core.replaySession(sessionId, at !== undefined ? { upToSeq: at } : {})
  console.log(`${c.dim}session:${c.reset} ${c.bold}${sessionId}${c.reset} ${c.dim}(events=${state.history.length}${at !== undefined ? `, up-to-seq=${at}` : ''})${c.reset}\n`)
  console.log(`${c.dim}systemPrompt (first 120)${c.reset}:`)
  console.log(`  ${c.dim}${state.systemPrompt.slice(0, 120).replace(/\n/g, ' ')}${c.reset}`)
  console.log()
  console.log(`${c.dim}events${c.reset}:`)
  for (const ev of state.history) {
    const sourceColor =
      ev.source === 'user' ? c.green :
      ev.source === 'model' ? c.cyan :
      ev.source === 'tool' ? c.yellow :
      ev.source === 'reasoning' ? c.magenta :
      c.gray
    const text = (ev.payload?.text ?? ev.payload?.command ?? '').toString().slice(0, 80).replace(/\n/g, ' ')
    console.log(`  ${c.dim}#${ev.seq}${c.reset} ${sourceColor}${ev.source.padEnd(10)}${c.reset} ${text}${c.dim}${text.length >= 80 ? '...' : ''}${c.reset}`)
  }
  console.log()
  console.log(`${c.dim}totals:${c.reset} ${state.totalTokens.toLocaleString()} tokens  ·  ${state.userInputs.length} user · ${state.toolCalls.length} tools`)
}

async function cmdFork(core: CordishubService, sessionId: string, flags: Argv): Promise<void> {
  const at = Number(flags.at ?? 0)
  if (!Number.isFinite(at) || at < 0) {
    console.error(`${c.red}error:${c.reset} 必须通过 --at <seq> 指定 fork 点`)
    process.exit(1)
  }
  banner()
  console.log(`${c.dim}fork session:${c.reset} ${sessionId} ${c.dim}at seq=${at}${c.reset}`)
  const newId = core.fork(sessionId, at)
  console.log(`${c.green}✓${c.reset} forked → ${c.bold}${newId}${c.reset}`)
}

async function cmdCost(core: CordishubService, flags: Argv): Promise<void> {
  banner()
  const sessionId = typeof flags.session === 'string' ? flags.session : undefined
  if (flags.json) {
    if (sessionId) {
      console.log(JSON.stringify(core.sessionCost(sessionId), null, 2))
    } else {
      console.log(JSON.stringify(core.costBreakdown(), null, 2))
    }
    return
  }
  const report = sessionId ? core.sessionCost(sessionId) : core.costBreakdown()
  const rows = Array.isArray(report) ? report : [report]
  console.log(`${c.dim}${'session'.padEnd(28)} ${'model'.padEnd(20)} ${'tokens'.padStart(12)}  ${'cost'.padStart(10)}${c.reset}`)
  console.log(`${c.dim}${'─'.repeat(28)} ${'─'.repeat(20)} ${'─'.repeat(12)}  ${'─'.repeat(10)}${c.reset}`)
  let totalTok = 0
  let totalCost = 0
  for (const r of rows) {
    console.log(
      `${(r as any).id.padEnd(28)} ${(r as any).model.padEnd(20)} ${((r as any).totalTokens ?? (r as any).total_tokens ?? 0).toLocaleString().padStart(12)}  $${((r as any).totalCost ?? (r as any).total_cost ?? 0).toFixed(4).padStart(8)}`,
    )
    totalTok += (r as any).totalTokens ?? (r as any).total_tokens ?? 0
    totalCost += (r as any).totalCost ?? (r as any).total_cost ?? 0
  }
  console.log(`${c.dim}${'─'.repeat(28)} ${'─'.repeat(20)} ${'─'.repeat(12)}  ${'─'.repeat(10)}${c.reset}`)
  console.log(
    `${c.bold}${'TOTAL'.padEnd(28)} ${' '.padEnd(20)} ${totalTok.toLocaleString().padStart(12)}  $${totalCost.toFixed(4).padStart(8)}${c.reset}`,
  )
}

async function cmdSearch(core: CordishubService, query: string, flags: Argv): Promise<void> {
  const limit = Number(flags.limit ?? 10)
  banner()
  console.log(`${c.dim}query:${c.reset} ${query}\n`)
  const hits = core.search(query, { limit })
  if (hits.length === 0) {
    console.log(`${c.yellow}没有匹配${c.reset}`)
    return
  }
  for (const h of hits) {
    console.log(`  ${c.cyan}${h.sessionId}${c.reset} ${c.dim}(${h.source})${c.reset}`)
    console.log(`  ${c.reset}  ${h.snippet}`)
    console.log()
  }
}

async function cmdSafety(core: CordishubService, flags: Argv): Promise<void> {
  const limit = Number(flags.limit ?? 20)
  banner()
  const events = core.safetyHistory({ limit })
  if (events.length === 0) {
    console.log(`${c.green}✓ 没活到 block 的事件${c.reset}`)
    return
  }
  for (const e of events) {
    const sev = e.severity === 'block' ? c.red : e.severity === 'warn' ? c.yellow : c.gray
    console.log(`  ${sev}[${e.severity.padEnd(5)}]${c.reset} ${c.dim}${e.source}${c.reset}  ${e.kind}: ${e.detail}`)
  }
}

async function cmdDashboard(core: CordishubService, flags: Argv): Promise<void> {
  const output = typeof flags.output === 'string' ? flags.output : path.join(process.cwd(), 'cordishub-dashboard.html')
  banner()
  const html = core.renderDashboard()
  fs.writeFileSync(output, html, 'utf8')
  console.log(`${c.green}✓${c.reset} Dashboard written: ${c.bold}${output}${c.reset}`)
  console.log(`${c.dim}open: file://${output}${c.reset}`)
}

async function cmdTui(core: CordishubService): Promise<void> {
  // 简易 TUI：清屏 + 菜单（不依赖 blessed / ink，100% ANSI）
  const lines = [
    `${c.cyan}${c.bold}┌─────────────────────────────────────────────┐${c.reset}`,
    `${c.cyan}${c.bold}│${c.reset}         CordisHub · Terminal UI           ${c.cyan}${c.bold}│${c.reset}`,
    `${c.cyan}${c.bold}├─────────────────────────────────────────────┤${c.reset}`,
    `${c.cyan}${c.bold}│${c.reset}  ${c.green}[1]${c.reset} Hub · 插件市场                         ${c.cyan}${c.bold}│${c.reset}`,
    `${c.cyan}${c.bold}│${c.reset}  ${c.green}[2]${c.reset} Cost · 仪表盘                          ${c.cyan}${c.bold}│${c.reset}`,
    `${c.cyan}${c.bold}│${c.reset}  ${c.green}[3]${c.reset} Replay · 终端回放                      ${c.cyan}${c.bold}│${c.reset}`,
    `${c.cyan}${c.bold}│${c.reset}  ${c.green}[4]${c.reset} Safety · 安全审计                       ${c.cyan}${c.bold}│${c.reset}`,
    `${c.cyan}${c.bold}│${c.reset}  ${c.green}[5]${c.reset} Search · 全文搜索                       ${c.cyan}${c.bold}│${c.reset}`,
    `${c.cyan}${c.bold}│${c.reset}  ${c.green}[q]${c.reset} Quit · 退出                             ${c.cyan}${c.bold}│${c.reset}`,
    `${c.cyan}${c.bold}└─────────────────────────────────────────────┘${c.reset}`,
    ``,
    `${c.dim}按数字选 5 个能力。 提示：TUI 仅是原型，生产环境接 ${c.reset}${c.cyan}Tauri 桌面端${c.reset}${c.dim}。${c.reset}`,
  ]
  console.log(lines.join('\n'))
  // 真实 TUI 留给后续 inquirer 集成，这里给一个可用提示
  console.log(`${c.dim}提示：直接跑 ${c.reset}${c.cyan}cordishub hub / cost / replay / safety / search${c.reset}${c.dim} 也可以。${c.reset}`)
}

// --------- 主分发 ---------
async function main(): Promise<void> {
  const { cmd, flags, rest } = parseArgs(process.argv.slice(2))

  if (flags.help || flags.h || cmd.length === 0) {
    printHelp()
    return
  }

  const [top, sub, ...rest_] = cmd
  const core = await loadCore()

  try {
    switch (top) {
      case 'hub': {
        const q = sub ?? rest[0] ?? ''
        if (!q) {
          console.error(`${c.red}error:${c.reset} cordishub hub <query>`)
          process.exit(1)
        }
        await cmdHub(core, q, flags)
        break
      }
      case 'replay': {
        if (!sub) {
          console.error(`${c.red}error:${c.reset} cordishub replay <session-id>`)
          process.exit(1)
        }
        await cmdReplay(core, sub, flags)
        break
      }
      case 'fork': {
        if (!sub) {
          console.error(`${c.red}error:${c.reset} cordishub fork <session-id>`)
          process.exit(1)
        }
        await cmdFork(core, sub, flags)
        break
      }
      case 'cost': {
        await cmdCost(core, flags)
        break
      }
      case 'search': {
        const q = sub ?? rest[0] ?? ''
        if (!q) {
          console.error(`${c.red}error:${c.reset} cordishub search <query>`)
          process.exit(1)
        }
        await cmdSearch(core, q, flags)
        break
      }
      case 'safety': {
        if (sub === 'review') {
          await cmdSafety(core, flags)
        } else {
          console.error(`${c.red}error:${c.reset} cordishub safety review`)
          process.exit(1)
        }
        break
      }
      case 'dashboard': {
        await cmdDashboard(core, flags)
        break
      }
      case 'tui': {
        await cmdTui(core)
        break
      }
      case 'version':
      case '--version':
      case '-v': {
        console.log('cordishub v0.1.0')
        break
      }
      default: {
        console.error(`${c.red}未知命令：${c.reset}${top}`)
        printHelp()
        process.exit(1)
      }
    }
  } finally {
    core.dispose()
  }
}

main().catch((err) => {
  console.error(`${c.red}error:${c.reset}`, err?.message ?? err)
  process.exit(1)
})