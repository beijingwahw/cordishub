/**
 * 在真实 DSH 里加载 CordisHub
 *
 * 这是 DSH v0.1+ 的标准插件接入方式。假设 DSH 已经通过
 * `npx @deepseek-ai/dsh` 安装好（参照 deepseek.ai/research/harness）。
 *
 * 文件路径：~/.dsh/plugins/cordishub-core.ts
 */
import { CordishubService, apply } from '../packages/core/src/index.ts'
import type { Context } from 'cordis'

/**
 * 方式 1：直接 install（最简）
 *
 * 在 DSH 启动命令里通过 --plugin cordishub-core.ts 加载。
 */
export function applyAsPlugin(ctx: Context): void {
  apply(ctx, {
    capabilities: { hub: true, replay: true, cost: true, safety: true },
    dbPath: process.env.CORDISHUB_DB ?? '~/.cordishub/cordishub.jsonl',
    onViolation: 'throw',
  })
}

/**
 * 方式 2：自定义 service（高级用户）
 *
 * 你可以在自己的服务里直接用 CordishubService 的能力，
 * 比如：自定义 plugin loader、定时任务、CI 集成。
 */
export function mountCustom(ctx: Context): CordishubService {
  const svc = new CordishubService(ctx, {
    dbPath: process.env.CORDISHUB_DB ?? '~/.cordishub/cordishub.jsonl',
    rates: [
      // 自定义费率表，形状必须是 ModelRate（promptPerMillion / completionPerMillion / ...），
      // 会整体替换默认的 DEEPSEEK_RATES
      {
        model: 'deepseek-v4-pro',
        promptPerMillion: 0.27,
        completionPerMillion: 1.10,
        reasoningPerMillion: 1.10,
        cacheReadPerMillion: 0.07,
      },
    ],
    capabilities: { hub: true, replay: true, cost: true, safety: true },
    // "prod 租户策略"：用 safetyPolicy 表达（单租户粒度；多租户时给每个租户各建一个 CordishubService）
    safetyPolicy: {
      tenant: 'prod',
      toolWhitelist: ['shell', 'read_file', 'http_get'],
      maxTokens: 1_000_000,
      maxCostUsd: 25,
      maxSubagents: 8,
      memoryGate: true,
      memoryGateThreshold: 0.6,
    },
    // 违规即抛错（对应旧版 blockToolOverflow 的"硬熔断"语义）
    onViolation: 'throw',
  })
  svc.install()

  // 在 DSH 里额外接 event：
  // - dsh start / session close → 触发 CordisHub
  // - dsh 上报 post-run summary 时调用 svc.renderDashboard() 上传到 S3
  ctx.on('internal/custom-end', () => {
    // 你自己的 hook：可以上传 dashboard 到 S3 / 推送 Notion / 等等
  })

  return svc
}