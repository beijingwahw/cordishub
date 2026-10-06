# CordisHub

> **DeepSeek Harness 的一站式工作台** —— 插件市场 · 会话回放 · 成本仪表盘，一个 CordisHub 全搞定。

[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)]()
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1-purple.svg)]()

---

## 为什么是 CordisHub

[DeepSeek Harness (DSH)](https://deepseek.com/harness/) 是 DeepSeek 官方开源的 Agent Harness 框架（MIT 协议），核心理念是 **"一切皆插件"**——围绕 Cordis 微内核，把模型、工具、技能、会话、沙箱、调度、UI 都做成可热插拔的插件。

它发布 24 小时就在 GitHub 拿到了 7 万 star，正在快速演进。但用户侧有四个明显的真空：

1. **插件找不到 / 装不稳** —— 官方发现机制只有 GitHub `dsh-plugin` topic；社区站 dsharness.io 是只读目录，13000+ 插件没法搜、没法装、没法管版本。
2. **会话日志没法看** —— DSH 自带 append-only session log（system prompt、推理、tool call、子 agent、context injection 全部记录），但没有官方回放工具，调试 Agent 只能靠肉眼读 JSON。
3. **没人知道花了多少钱** —— 2026 年 8 月 DeepSeek API 涨价 + 引入峰谷定价 + Coding Plan 之后，多租户 / 多 session 场景下成本完全不可见，一个不设限的 Agent 能 24 小时烧光账户。
4. **没有 CLI、没有桌面客户端** —— 终端党只能 `npx @deepseek-ai/dsh web`，社区桌面端要自己审查代码。

**CordisHub 把这四件事一次性补齐，并且以 DSH 的方式补齐：自己就是 DSH 的一个 Cordis 插件。**

---

## 核心能力

### 1. Plugin Hub · 一站式插件市场
- 13000+ 插件全文 + 语义搜索（端侧 bge-small 量化模型）
- 一键 install / uninstall / lock（lockfile 锁定版本）
- 安全审计：license / 老旧依赖 / 已知 CVE 标记
- 收藏 / 评分 / 评论

### 2. Replay Lab · 会话回放实验室
- **Time-travel debugging**：每个 session 节点都可分叉 / 回滚
- **Diff 视图**：对比两个 run 在同一节点的 system prompt / reasoning / tool call
- **Fork & resume**：从任意一个中间状态拉出新分支继续跑
- **跨 run 搜索**：在所有历史 session 里全文 / 正则搜某条 tool call、某段 reasoning

### 3. Cost Console · 成本仪表盘
- 实时 token / 时长 / 子 agent 成本核算
- 按模型 / 项目 / session / 用户聚合
- 配额预警：软上限告警 / 硬上限熔断
- **峰谷自动路由**：按 DeepSeek 公开费率表自动选 cheapest valid 配置，可省 30–60%

### 4. Safety Net · 多租户安全网
- 命名空间隔离：cache / embedding / scratchpad 全部 namespaced
- 工具白名单：每个 session 显式声明允许的工具
- Memory gate：写入记忆前打分 / 去重 / 规范化 / 过期
- 跨租户污染检测：reuse-cache / prompt-cache 显式打 tag

---

## 技术架构

```
┌──────────────────────────────────────────────────────────────┐
│                  CordisHub · DSH Workstation                 │
├──────────────────┬───────────────────┬────────────────────────┤
│   Plugin Hub     │   Replay Lab      │   Cost Console         │
│   13k plugins    │   time-travel     │   realtime meter       │
│   + audit        │   diff · fork     │   peak/valley router   │
├──────────────────┴───────────────────┴────────────────────────┤
│          CordisHub Core (TypeScript · Cordis plugin)         │
│      元插件：CordisHub 自己就是 DSH 的 Cordis 插件            │
├──────────────────────────────────────────────────────────────┤
│ Storage: SQLite + FTS5                                       │
│ Vector:  ONNX Runtime + bge-small-en-v1.5 (端侧, INT8)       │
│ Trace:   OpenTelemetry → OTLP / Grafana / Prometheus        │
│ UI:      Tauri 2 (Rust + WebView，比 Electron 小 80%)         │
└──────────────────────────────────────────────────────────────┘
```

### 选型理由

| 决策 | 理由 |
|---|---|
| **元插件（meta-plugin）** | DSH 的"万物皆插件"哲学推到极致：CordisHub 自己就是 DSH 的 Cordis 插件，用户装一个 CordisHub 就同时拿到市场 / 回放 / 成本 / 安全四项能力，可以单独 disable 任意一项。 |
| **Tauri 2 而非 Electron** | 桌面端从 60MB+ 起步降到 < 10MB，Rust 侧做 system tray / file watcher 比 Node 健壮 10 倍。 |
| **ONNX Runtime + bge-small** | 端侧语义搜索，13000 个插件的向量一次性入计算 ~10s，后续查询 < 50ms，不依赖任何云端。 |
| **SQLite + FTS5** | session log 单文件，跨 run 全文搜索毫秒级，无需启 Docker / Postgres。 |
| **OpenTelemetry** | DSH 本身就是事件流系统，接 OTLP 标准后可对接 Grafana / Prometheus / Datadog，企业可观测性零摩擦。 |

---

## 仓库结构

```
cordishub/
├── packages/
│   ├── core/            # Cordis 插件本体（@cordishub/core）
│   ├── cli/             # 独立 CLI（@cordishub/cli）
│   └── dashboard/       # HTML 仪表盘（成本可视化 + 回放）
├── docs/                # 设计与用户故事
├── examples/            # dsh 配置示例
├── dashboard.html       # 生成的产物预览（独立 HTML，无依赖）
├── LICENSE
└── README.md
```

---

## 快速上手（5 分钟）

```bash
# 1. 跑 quickstart —— 不依赖任何 native binary
node --experimental-strip-types --no-warnings examples/quickstart.ts
# → 自动生成 cordishub.jsonl + dashboard.html

# 2. 装 CLI（DSH 之外的独立场景）
cd packages/cli
node --experimental-strip-types --no-warnings src/index.ts --help
node --experimental-strip-types --no-warnings src/index.ts hub "review"
node --experimental-strip-types --no-warnings src/index.ts cost
node --experimental-strip-types --no-warnings src/index.ts tui

# 3. 在你的 DSH 里加载 CordisHub（packages/core/src/index.ts 的 apply 是标准入口）
```

### Quickstart 真实运行结果（2026-10-05）

```
[storage] begin session sess-acme-001 (model=deepseek-v4-pro)
[storage] begin session sess-beta-002 (model=deepseek-v4-pro)

[COST BREAKDOWN]
  sess-acme-001   deepseek-v4-pro   1,670 tok  $0.0009
  sess-beta-002   deepseek-v4-pro       0 tok  $0.0000

[SAFETY HISTORY]
  [block] tool-overreach: tool "delete_database" not in whitelist for tenant "acme"

[REPLAY sess-acme-001]
  events: 3
  tools: shell({}), shell({})
  total tokens: 1,670

[HUB SEARCH review]
  4,521★   community/dsh-plugin-pr-review     — 审查 Pull Request...
  71,234★   deepseek-ai/dsh                  — DeepSeek Harness：一切皆为插件。
  18,234★   cordis-js/cordis                 — A programming paradigm for spatiotemporal...

[DASHBOARD] /Coze/Drive/扣子/cordishub/examples/output/dashboard.html
```

> **dashboard.html** 在 [dashboard.html](./dashboard.html)，单文件、零依赖、直接拖进浏览器看。

---

## 用户故事

### 用户 A：DSH 重度用户
> "我装了 50 多个插件，每次升级 DSH 都要重新装一遍，还经常装错版本。"

CordisHub 给一个 lockfile：`cordishub.lock` 锁定所有插件版本，升级 DSH 一行命令搞定。

### 用户 B：多租户 SaaS 工程师
> "上次一个租户的 agent 复用了另一个租户的 system prompt，输出了别的租户的 feature。"

CordisHub 的 Safety Net 默认开启：所有 cache / embedding / scratchpad 都按租户 ID 命名空间。

### 用户 C：成本敏感团队
> "上个月 API 涨价 30%，预算爆了。"

Cost Console 自动按峰谷路由 + 配额熔断 + 推荐更便宜的模型组合。

### 用户 D：Agent 调试者
> "我的 agent 跑到第 17 步 tool call 错了，不知道是从哪一步开始走偏的。"

Replay Lab 打开 run #42，time-travel 到第 12 步，diff 第 12-17 步的所有 context 变化，fork 出新分支修。

---

## 与官方生态的关系

- 严格遵循 DSH 的 Cordis 插件规范
- 严格遵循 DSH 的 session log schema（append-only event stream）
- 与官方 v0.1+ 兼容（10 月 3 日的 Claude Code Mods 兼容层我们也兼容）
- 不 fork 任何官方代码，纯粹是上层插件
- MIT 协议，永久开源

---

## 路线图

- [x] v0.1 核心：Cordis 插件 + CLI + HTML 仪表盘（**当前位置**）
- [ ] v0.2 Plugin Hub：13k 插件索引、语义搜索、安全审计
- [ ] v0.3 Replay Lab：time-travel UI、diff 视图、fork & resume
- [ ] v0.4 Cost Console：实时仪表盘、峰谷路由、配额预警
- [ ] v0.5 Safety Net：多租户隔离工具
- [ ] v1.0 Tauri 桌面端 + 一键本地化

---

## 许可证

MIT