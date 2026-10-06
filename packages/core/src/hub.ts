/**
 * 插件市场 / Hub
 *
 * 与 GitHub 的 dsh-plugin topic 协作：
 *   - 列出 GitHub 上所有带 dsh-plugin topic 的仓库
 *   - 解析 README 提取 plugin / instruction
 *   - 缓存到本地 SQLite 索引（构建一次 ~10s，后续查询毫秒级）
 *
 * 离线索引格式（首次启动后写入本地 db）：
 *   - name, owner, repo, stars, license, deps (inferred), description, lastUpdated
 *
 * 真实开发时可对接 GitHub GraphQL API（需 GITHUB_TOKEN）。
 * 这里给出一个 mock 数据 + 真实可用的 search/install 骨架。
 */

import type { Storage } from './storage.ts';

export interface PluginMeta {
  name: string;
  owner: string;
  repo: string;
  fullName: string;
  description: string;
  stars: number;
  license: string;
  /** 解析 README 得到的 plugin 调用方式 */
  entry: string;
  /** 安装命令 */
  installCmd: string;
  /** 最后更新时间 */
  updatedAt: string;
  /** 是否官方 */
  official: boolean;
  /** tag 列表 */
  tags: string[];
  /** 健康度评分（综合 Star 数 / commit 频率 / 文档完整度） */
  health: number;
}

export interface SearchOptions {
  query?: string;
  tag?: string;
  official?: boolean;
  minStars?: number;
  limit?: number;
}

export class HubIndex {
  private cache = new Map<string, PluginMeta>();

  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** 导入一组插件元数据（通常来自 GitHub GraphQL 或本地 fixture） */
  ingest(plugins: PluginMeta[]): void {
    for (const p of plugins) {
      this.cache.set(p.fullName, p);
      this.storage.writeKv('hub', p.fullName, p);
    }
  }

  /** 从持久化存储加载全量索引 */
  load(): number {
    for (const { key, value } of this.storage.listKv<PluginMeta>('hub')) {
      this.cache.set(key, value);
    }
    return this.cache.size;
  }

  /** 搜索（纯内存，支持简单过滤） */
  search(opts: SearchOptions): PluginMeta[] {
    const limit = opts.limit ?? 50;
    const q = opts.query?.toLowerCase();
    const results: Array<{ plugin: PluginMeta; score: number }> = [];

    for (const p of this.cache.values()) {
      if (opts.official && !p.official) continue;
      if (opts.minStars && p.stars < opts.minStars) continue;
      if (opts.tag && !p.tags.includes(opts.tag)) continue;

      let score = 0;
      if (q) {
        const hay = `${p.name} ${p.description} ${p.tags.join(' ')}`.toLowerCase();
        if (hay.includes(q)) score += 10;
        if (p.name.toLowerCase().includes(q)) score += 20;
        if (p.description.toLowerCase().includes(q)) score += 5;
      } else {
        score = 1;
      }
      score += Math.log10(p.stars + 1) * 5;
      score += p.health * 3;
      if (score > 0) results.push({ plugin: p, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map((r) => r.plugin);
  }

  /** 安装一个插件（返回建议的命令） */
  install(fullName: string, packageManager: 'pnpm' | 'npm' | 'yarn' = 'npm'): {
    cmd: string;
    plugin: PluginMeta;
  } {
    const p = this.cache.get(fullName);
    if (!p) throw new Error(`Plugin ${fullName} not found in index`);
    const cmd =
      packageManager === 'pnpm'
        ? `pnpm add @${p.owner}/${p.name}`
        : packageManager === 'yarn'
          ? `yarn add @${p.owner}/${p.name}`
          : `npm install @${p.owner}/${p.name}`;
    return { cmd, plugin: p };
  }

  /** 写一个 lockfile，把已选插件固化下来 */
  writeLockfile(filename: string, pinned: PluginMeta[]): string {
    const lock = {
      version: 1,
      generatedAt: new Date().toISOString(),
      plugins: pinned.map((p) => ({
        name: p.fullName,
        version: '^latest', // 真实场景从 LSP pull 解析
        resolved: `https://github.com/${p.owner}/${p.repo}.git`,
        integrity: '',
      })),
    };
    const fs = require('fs') as typeof import('fs');
    fs.writeFileSync(filename, JSON.stringify(lock, null, 2));
    return filename;
  }
}

/**
 * 内置"演示用"插件数据集 —— 真实场景应从 GitHub GraphQL 拉取。
 * 这里给出 6 个代表性插件，覆盖官方、第三方、热门分类。
 */
export const DEMO_PLUGINS: PluginMeta[] = [
  {
    name: 'dsh',
    owner: 'deepseek-ai',
    repo: 'deepseek-harness',
    fullName: 'deepseek-ai/dsh',
    description: 'DeepSeek Harness：一切皆为插件。',
    stars: 71234,
    license: 'MIT',
    entry: 'import { apply } from "@deepseek-ai/dsh"',
    installCmd: 'npx @deepseek-ai/dsh web',
    updatedAt: '2026-10-03',
    official: true,
    tags: ['agent', 'harness', 'core'],
    health: 0.98,
  },
  {
    name: 'cordis',
    owner: 'cordis-js',
    repo: 'cordis',
    fullName: 'cordis-js/cordis',
    description: 'A programming paradigm for spatiotemporal composability — DSH 的底层微内核。',
    stars: 18234,
    license: 'MIT',
    entry: 'import { Context } from "cordis"',
    installCmd: 'npm install cordis',
    updatedAt: '2026-09-12',
    official: false,
    tags: ['kernel', 'microkernel'],
    health: 0.92,
  },
  {
    name: 'pr-review',
    owner: 'community',
    repo: 'dsh-plugin-pr-review',
    fullName: 'community/dsh-plugin-pr-review',
    description: '审查 Pull Request，自动留 review comment、发现高风险 diff。',
    stars: 4521,
    license: 'MIT',
    entry: 'register({ name: "pr-review", apply })',
    installCmd: 'npm install @community-dsh/pr-review',
    updatedAt: '2026-09-28',
    official: false,
    tags: ['git', 'review', 'code-quality'],
    health: 0.85,
  },
  {
    name: 'doc-generator',
    owner: 'community',
    repo: 'dsh-plugin-doc-gen',
    fullName: 'community/dsh-plugin-doc-gen',
    description: '从代码生成 API 文档、OpenAPI 规范、Postman 集合。',
    stars: 2891,
    license: 'MIT',
    entry: 'register({ name: "doc-gen", apply })',
    installCmd: 'npm install @community-dsh/doc-gen',
    updatedAt: '2026-08-15',
    official: false,
    tags: ['docs', 'openapi'],
    health: 0.78,
  },
  {
    name: 'mcp-bridge',
    owner: 'community',
    repo: 'dsh-plugin-mcp-bridge',
    fullName: 'community/dsh-plugin-mcp-bridge',
    description: 'MCP 桥接：在 DSH 里直接接 Claude Code / Cursor / 其它 MCP 服务。',
    stars: 6721,
    license: 'Apache-2.0',
    entry: 'register({ name: "mcp-bridge", apply })',
    installCmd: 'npm install @community-dsh/mcp-bridge',
    updatedAt: '2026-09-30',
    official: false,
    tags: ['mcp', 'integration'],
    health: 0.91,
  },
  {
    name: 'cost-guard',
    owner: 'community',
    repo: 'dsh-plugin-cost-guard',
    fullName: 'community/dsh-plugin-cost-guard',
    description: '实时 token 配额 + 峰谷路由 + 成本熔断。CordisHub 的核心组件。',
    stars: 1342,
    license: 'MIT',
    entry: 'register({ name: "cost-guard", apply })',
    installCmd: 'npm install @cordishub/core',
    updatedAt: '2026-10-05',
    official: false,
    tags: ['cost', 'observability', 'guard'],
    health: 0.88,
  },
];