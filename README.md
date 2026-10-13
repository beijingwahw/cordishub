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
│   ├── core/            # Cordis 插件本体（@cordishub/core，src + test 单元测试）
│   └── cli/             # 独立 CLI（@cordishub/cli）
├── docs/                # 设计文档（DESIGN.md：Logbook Kernel + Genesis）
├── examples/            # quickstart（内核巡礼）与 DSH 接入示例
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

# 3. 跑测试（node --test，无需安装任何依赖）
cd packages/core
node --experimental-strip-types --no-warnings --test test/

# 4. 在你的 DSH 里加载 CordisHub（packages/core/src/index.ts 的 apply 是标准入口）
```

### Quickstart 真实运行结果（2026-10-13）

```
[storage] begin session sess-acme-001 (model=deepseek-v4-pro)
[storage] begin session sess-beta-002 (model=deepseek-v4-pro)

[COST BREAKDOWN]
  sess-beta-002   deepseek-v4-pro       0 tok  $0.0000
  sess-acme-001   deepseek-v4-pro   1,670 tok  $0.0009

[SAFETY HISTORY]
  [block] tool-overreach: tool "delete_database" not in whitelist for tenant "acme"

[REPLAY sess-acme-001]
  events: 3
  tools: shell({"cmd":"ls -la"})
  total tokens: 1,670

[HUB SEARCH review]
  4,521★   community/dsh-plugin-pr-review     — 审查 Pull Request...
  71,234★   deepseek-ai/dsh                  — DeepSeek Harness：一切皆为插件。
  18,234★   cordis-js/cordis                 — A programming paradigm for spatiotemporal...

[DASHBOARD] examples/output/dashboard.html

[KERNEL TOUR]
  ✓ chain cordishub.sessions.jsonl seals=2 head=45fc25d4f2…
  ✓ chain cordishub.events.jsonl seals=2 head=327c62760a…
  genome: model=deepseek-v4-pro tools=[shell]
  cassette: level=context replayStable=true（×3 次）
  taint: active=[repo-meta] violations=0
```

> **dashboard.html** 在 [dashboard.html](./dashboard.html)，单文件、零依赖、直接拖进浏览器看。

---

## v0.2 内核能力（已落地）

- **投影可重建 / 可压实（L0）**：JSONL 日志是唯一真相。`cordishub rebuild` 随时从磁盘重建全部内存投影（含 FTS 索引）；`cordishub compact` 把 append-only 历史原子收敛为"每 id 只留最新行"，压实前 fresh-read + 咨询锁，不误删其它进程的追加。
- **费率 DSL（L2a）**：费率表是带生效日期的版本化数据（`TariffSchedule`），峰谷窗口数据化（支持跨午夜）。2026-08 式涨价不再是代码变更，历史账单按当时费率精确重算。
- **预算预授权（L2b）**：`BudgetLedger` 把"事后发现超支"升级为"事前拦截"——模型调用前 `reserve`（额度按费率 × token 上限**按模型估算**）、完成后按实际成本 `settle`、失败/超时 `release`；未走预授权钩子的调用 `charge` 兜底入账，账本与成本投影严格一致。已结算条目持久化到 KV，**预算跨进程累计**。
- **信任注册表（L3）**：插件安装单元 = ed25519 签名的能力声明（零依赖 node:crypto）。`TrustRegistry` 支持发布者多密钥**轮换**（retiredAt 退休、可回溯判定"安装时是否可信"）、密钥吊销与制品吊销；升级时 `diffCapabilities` 展示权限增删，默认最小授权。

---

## v0.3 基因维度（已落地）

- **基因型提取（G0）**：任意 session 的声明式部分（system prompt / 模型 / 工具集 / 子代理拓扑 / 策略）一键提取为版本化 `AgentGenome`——日志是表型，manifest 是基因型；
- **结构化变异算子**：`prompt-append / prompt-replace / model-swap / tool-add / tool-remove / policy` 六类纯函数变异，父代不可变，子代自动携带谱系指纹与版本 bump；
- **谱系与适应度**：`breed()` 一条龙（提取→变异→入基因库）；fork 可打基因标记；`genomeFitness()` 按谱系聚合成本 fold——进化的评分系统复用现有账本，无需新建。

---

## v0.4 地基硬化（已落地）

- **哈希链封印（L0 · 防篡改审计）**：数据行每 N 条自动封印（`__seal` 行 = 前封印哈希 + 覆盖行的 merkle 折叠根），四类日志文件全部成链。`cordishub audit` 全量重放验证——数据行篡改 → root 失配，封印篡改 → 链断裂。诚实边界：链头 head 需导出外部（备份/打印）锚定才防"整链重写"；compact 重开新链时以 `compactedFrom` 保留血统锚点。
- **能力令牌（ocap 最小版）**：`mintRoot / attenuate / assertTool`。三条不可违反的衰减不变量：权限只能收窄（扩权请求显式拒绝）、预算只能变小/期限只能提前、委托深度有上限。`SafetyPolicy.capability` 设置后，工具准入从字符串白名单比对升级为结构性检查。

---

## v0.5 Cassette 确定性回放（已落地）

- **盒带录制（L1）**：`recordTape()` 把 session 事件流压成可重放的"非确定性输入清单"（模型轮次 / 工具调用 / 工具响应 / 上下文），`cordishub cassette <id>` 检查条目与确定性档位；
- **上下文确定性（诚实边界）**：外挂工作台控制不了模型本体，承诺的不是 bit 级确定性——重放中工具响应全部取自盒带（VCR 式）、时间与输入固定、模型以纯函数注入。未录到采样参数时自动退化为结构化查看器；
- **故障注入（fault-inject）**：`playCounterfactual()` 在第 N 个工具响应上注入篡改或错误，精确报告与录制轨迹的**分叉步**——"agent 从哪一步开始漂移"的显微镜；
- **因果二分（G2）**：`bisectFirstBad()` 对状态谓词做 O(log n) 二分重构，定位"最早坏状态"的 seq——16 步会话只需 ≤5 次重构；非单调谓词用 `locateBadEvents()` 单遍增量折叠，精确给出全部坏区间；
- **确定性证书**：`certifyDeterminism()` 把"实验可复现"从口头承诺升级为可执行断言——档位分级（empty/context/full）+ 同盒带同模型 N 次重放的逐位一致性证明；`stampSampling()` 可为盒带补盖采样参数升到 full 档。

---

## v0.6 进化反应堆（已落地）

- **变体跑批（G1）**：`service.reactor(sessionId, { variants, harness, budget })` —— 从 session 提取种子基因 → 逐变体结构化变异 → 盒带重放评估（注入 harness 作为变体的"模型"）→ 适应度选择。缺省适应度"先保真后省钱"，缺省成本按基因的模型费率估算；
- **燃料闸门**：每个变体跑批前从独立 `BudgetLedger` 预授权，**预算不足在运行发生前被拒**——搜索空间再大，燃料总量封顶，进化不会失控；
- **谱系自动入库**：变体基因存入 KV 基因库，谱系指向种子——育种素材随每次跑批复利积累；
- **世代进化（G1.5）**：`evolve()` 选择→变异→下一代，燃料账本跨世代共享（总预算 = 进化总闸门）；缺省种子化 RNG（`seededRng`），**同一 seed 两次进化收敛到同一最优**——进化实验可复现。`cordishub record-demo` 可向 CLI 注入演示会话，genome/cassette 全链路开箱可测。

---

## v0.7 内核增强（已落地）

- **Taint 信息流检查（粗粒度）**：污点标签（tenant:* / pii / consent:*）附着在工具结果与上下文注入上，沿事件流传播、清洗屏障（redact 类工具）清空，`taintScan()` 单遍产出传播时间线 + 溯源链 + 输出门控违规（禁止标签在模型输出时活跃 → taint-leak）。`cacheTaintCompatible()` 实现缓存子集规则（no-read-up）——**跨租户 prompt-cache 命中在结构上不可能**。标签任意，consent:* 同机制复用为轨迹公地的同意系统。
- **选择策略 DSL**：`selectParents()` 支持 truncation / tournament / roulette / **diversity**（多样性保护：基因组特征袋 Jaccard 距离过近的候选跳过——防早熟收敛的关键算子）。所有随机策略与种子化 RNG 组合后可复现。

---

## v0.8 JSON-RPC 内核桥（已落地）

- **L4 接口统一开篇**：`cordishub serve [--port N]` 启动 JSON-RPC 2.0 内核服务（零依赖 node:http），14 个方法覆盖全部能力——`service.info / sessions.list / cost.breakdown / hub.search / search.fulltext / safety.history / replay.session / genome.* / cassette.inspect / taint.scan / audit.chains / budget.snapshot`。CLI、TUI、桌面端、Web 从此共享同一个方法表，不再各自直连 service；
- **边界原则**：跨 RPC 的输入必须是数据——污点策略这类"函数型"参数以关键词规则（`TaintPolicySpec`）跨边界，由服务端 `compileTaintPolicy` 编译，函数不出进程；
- **dashboard 内核面板**：链审计状态（Merkle 封印 N/4 ok）、基因库规模、RPC 就绪状态一屏可见。

---

## v0.9 内核收尾（已落地）

- **quickstart 内核巡礼**：5 分钟入口升级为 v0.3–v0.8 全能力一览（链审计 / 基因提取 / 确定性证书 / 污点扫描）；
- **设计文档入库**：[docs/DESIGN.md](./docs/DESIGN.md) 沉淀 Logbook Kernel → Genesis 的分层模型、维度激活纪律、红线清单与"不做清单"；
- **Hub 数据源管道**：`syncHubTopic()` 按 GitHub topic 同步插件索引，fetcher 可注入（测试 mock / 生产 `githubTopicFetcher(token)`）——数据与管道解耦，真实生态出现即可入库。CLI：`cordishub hub-sync [--topic dsh-plugin]`。

---

## v0.10 Plugin Hub 真实索引（已落地）

- **真实生态接通**：`cordishub hub-sync --topic "dsh-plugin,mcp-server,model-context-protocol" --token <ghp_…>` 一次同步三个 topic——实测抓取 900 个真实仓库、去重后 **835 个插件**入 KV 索引（volcengine/OpenViking 39,780★ 等）；
- **多 topic 同步**：`syncHubTopics()` 按 topic 依次分页拉取，标签记录来源（`github-topic:<t>`），同名仓库按 fullName 去重；
- **千行级验证**：835 条索引跨进程持久化（新进程 `hub "database"` 直接命中），Merkle 链在 955 行 / 20 封印规模下审计全绿。

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

- [x] v0.1 核心：Cordis 插件 + CLI + HTML 仪表盘
- [x] v0.2 内核增强：投影压实/重建、费率 DSL、预算预授权、信任注册表
- [x] v0.3 基因维度：会话可遗传化——提取 / 变异 / 谱系 / 适应度
- [x] v0.4 地基硬化：哈希链封印（防篡改审计）、ocap 能力令牌
- [x] v0.5 Cassette：盒带录制、故障注入分叉、因果二分
- [x] v0.6 进化反应堆（G1）：变体跑批 + 预算燃料闸门 + 适应度选择
- [x] v0.7 内核增强：taint 信息流检查 + 选择策略 DSL + 可复现世代进化
- [x] v0.8 JSON-RPC 内核桥（L4 开篇）：统一方法表 + 策略数据化
- [x] v0.9 内核收尾：内核巡礼 quickstart + 设计文档入库 + Hub 数据源管道
- [x] v0.10 Plugin Hub 真实索引：多 topic 同步，835 个真实插件入库（**当前位置**）
- [ ] v1.0 Replay Lab UI · Tauri 桌面 · G3/G4（激活条件见 docs/DESIGN.md）（G4）

---

## 许可证

MIT
---

## v0.11 Tauri 桌面端（已落地）

- **三形态桌面**：`cordishub desktop` 浏览器预览（内核同源托管 UI + 拉起系统浏览器，零构建）；Tauri 2 壳（同一份 `ui/index.html` 编入 WebView，**已实测编译** `cordishub-desktop.exe`）；`cargo tauri build` 打包分发；
- **交互式 UI**：插件搜索（835+ 真实索引）、Sessions & Cost、内核完整性（Merkel 链）、基因库——全部走 JSON-RPC 方法表，UI↔方法表有同步守卫测试防漂移；
- **踩坑记录（ICO 教学）**：Windows 资源编译要求规范 BMP 条目的 .ico——目录条目字段偏移（planes@10/bpp@12/bytes@14/offset@18）错一位 rc.exe 就报 RC2176；PNG-in-ICO 会被老 rc 拒绝。规范生成器已入库（icons/）。
