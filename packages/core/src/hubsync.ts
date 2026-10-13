/**
 * Hub 数据源管道 —— 把"13k 插件索引"从 mock 变成可接真实源的管道。
 *
 * GitHub Search API 按 topic 拉取仓库 → PluginMeta 映射 → 入库（KV 持久化，
 * 重启后 hub.load() 恢复）。fetcher 可注入：测试用 mock，生产用
 * githubTopicFetcher(token?)——依赖注入让管道的真伪与数据源解耦。
 */
import type { HubIndex, PluginMeta } from './hub.ts';

export interface GithubRepo {
  full_name: string;
  description: string | null;
  stargazers_count: number;
  html_url: string;
  pushed_at: string;
  owner: { login: string };
  license?: { spdx_id: string } | null;
}

export type RepoFetcher = (topic: string, perPage: number, page: number) => Promise<GithubRepo[]>;

/** GitHub Search API fetcher（token 可选：匿名有限额，官方生态建议带 token） */
export function githubTopicFetcher(token?: string): RepoFetcher {
  return async (topic, perPage, page) => {
    const url =
      `https://api.github.com/search/repositories?q=topic:${encodeURIComponent(topic)}` +
      `&per_page=${perPage}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'cordishub-hub-sync',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) {
      throw new Error(`github api ${res.status} for topic ${topic}`);
    }
    const json = (await res.json()) as { items?: GithubRepo[] };
    return json.items ?? [];
  };
}

/** 仓库 → 插件元数据映射（health 用对数启发式压平 star 量级） */
export function toPluginMeta(repo: GithubRepo): PluginMeta {
  const [owner = 'unknown', name = repo.full_name] = repo.full_name.split('/');
  return {
    name,
    owner,
    repo: name,
    fullName: repo.full_name,
    description: repo.description ?? '',
    stars: repo.stargazers_count ?? 0,
    license: repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : 'Unknown',
    entry: '',
    installCmd: '',
    updatedAt: repo.pushed_at?.slice(0, 10) ?? '',
    official: owner === 'deepseek-ai',
    tags: ['github-topic'],
    health: Math.min(1, Math.log10((repo.stargazers_count ?? 0) + 1) / 5),
  };
}

/** 同步一个 topic 到 hub 索引（分页拉取 + 映射入库），返回同步的仓库数 */
export async function syncHubTopic(
  hub: HubIndex,
  opts: { fetcher: RepoFetcher; topic?: string; maxPages?: number; perPage?: number } = { fetcher: githubTopicFetcher() },
): Promise<number> {
  const topic = opts.topic ?? 'dsh-plugin';
  const perPage = opts.perPage ?? 100;
  const maxPages = opts.maxPages ?? 1;
  let count = 0;
  for (let page = 1; page <= maxPages; page++) {
    const repos = await opts.fetcher(topic, perPage, page);
    if (repos.length === 0) break;
    hub.ingest(repos.map(toPluginMeta));
    count += repos.length;
    if (repos.length < perPage) break;
  }
  return count;
}

/**
 * 多 topic 同步：按 topic 依次分页拉取，标签记录来源 topic
 * （`github-topic:<t>`），跨 topic 的同名仓库按 fullName 自然去重（KV upsert）。
 * 返回按 topic 的计数（fetched 口径），索引内的唯一数以 hub.search 为准。
 */
export async function syncHubTopics(
  hub: HubIndex,
  opts: {
    fetcher: RepoFetcher;
    topics: string[];
    maxPages?: number;
    perPage?: number;
    onProgress?: (topic: string, fetched: number) => void;
  },
): Promise<{ total: number; byTopic: Record<string, number> }> {
  const perPage = opts.perPage ?? 100;
  const maxPages = opts.maxPages ?? 3;
  const byTopic: Record<string, number> = {};
  let total = 0;
  for (const topic of opts.topics) {
    let fetched = 0;
    for (let page = 1; page <= maxPages; page++) {
      const repos = await opts.fetcher(topic, perPage, page);
      if (repos.length === 0) break;
      hub.ingest(
        repos.map((r) => {
          const meta = toPluginMeta(r);
          meta.tags = [`github-topic:${topic}`];
          return meta;
        }),
      );
      fetched += repos.length;
      if (repos.length < perPage) break;
    }
    byTopic[topic] = fetched;
    total += fetched;
    opts.onProgress?.(topic, fetched);
  }
  return { total, byTopic };
}
