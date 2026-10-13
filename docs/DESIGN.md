# CordisHub 设计文档（Logbook Kernel → Genesis）

> 本文沉淀 v0.2–v0.9 的架构决策与取舍。核心论点只有一句话：
> **DSH 的哲学是"一切皆事件流"；把它推到自洽极限——CordisHub 本身就是 DSH 日志上的一个 fold（投影）+ 策略钩子。**"元插件"不是修辞，是字面架构。

## 一、分层模型

```
              ┌─ 会话状态      ┌─ 成本账本        ┌─ 安全审计
   Logbook ───┤─ FTS/语义索引  ├─ 预算预授权      ├─ 能力令牌(ocap)
 (唯一真相)    └─ 插件索引      └─ 峰谷路由        └─ taint 信息流
        ↑ 回放 = 从日志前缀重启子 harness（fork = 引用，不是复制）
        ↘ JSON-RPC 方法表 → CLI / TUI / 桌面 / Web
```

- **L0 Substrate**：append-only JSONL + 单一身份规则（`id` / `kv:table::key` / `session::cp` 复合键）+ camelCase 规范化（旧 snake 数据读入透明迁移）+ 哈希链封印（防篡改）+ 压实（O(n²) 膨胀收敛，compactedFrom 血统锚点）+ 投影重建（`rebuild`）；
- **L1 Determinism（Cassette）**：诚实边界 = **上下文确定性**——工具响应从盒带重放、时间/输入固定、模型以纯函数注入；确定性证书分级（empty/context/full）+ 可执行稳定性证明；因果二分（单调谓词 O(log n)）与区间扫描（非单调谓词单遍精确）；
- **L2 Policy**：费率 DSL（生效日期版本化，历史账单按当时费率重算）+ 预算预授权（reserve/settle/release/charge，跨进程持久，模型感知额度估算）+ ocap（三条衰减不变量：权限只收窄、预算只变小/期限只提前、委托深度有上限）+ taint（缓存子集规则 no-read-up，跨租户 prompt-cache 命中结构上不可能）；
- **L3 Market**：签名 manifest（ed25519）+ 能力 diff + TrustRegistry（多密钥轮换、retiredAt 退休可回溯判定、密钥/制品吊销）+ 数据源管道（fetcher 可注入的 GitHub topic 同步）；
- **L4 Interface**：JSON-RPC 2.0 统一方法表（14 方法覆盖全部能力）；边界原则——跨 RPC 的输入必须是数据，函数型参数（污点策略）以规则形态跨界、服务端编译。

## 二、Genesis：从记录到搜索

进化的三要素全部藏在日志里：遗传物质 = 声明式配置（`AgentGenome`）、变异 = 结构化算子（六类纯函数）、选择压 = 成本 fold（`fitnessOf`）。链路：

```
提取(G0) → 变异 → 燃料预授权(BudgetLedger) → 盒带评估(Cassette) → 适应度
   → 选择(策略 DSL: truncation/tournament/roulette/diversity) → 下一代(evolve)
```

关键设计：
- **燃料闸门**：变体跑批前 reserve，预算不足在运行发生前被拒——搜索空间再大，燃料总量封顶；harness 异常时预授权释放（闸门不因实验失败而锁死）；
- **可复现进化**：缺省种子化 RNG（mulberry32），同 seed 两次进化收敛同一最优；
- **多样性保护**：基因组特征袋 Jaccard 距离过近的候选跳过——防早熟收敛。

## 三、维度激活纪律（得失兼顾的执行机制）

高维能力必须由低维层的真实负载"挣"出来，未达条件保持关闭：

| 维度 | 激活条件 | 未达条件时 |
|---|---|---|
| 世代进化 | 同类任务 ≥N 次真实运行 | 单批跑批 |
| G3 内部市场 | 真实多租户/并发争抢 | reserve/settle 配给制 |
| G4 轨迹公地 | TrustRegistry 生态 + taint 成熟 | 不出本机 |
| Plugin Hub 语义索引 | 真实数据源出现 | 数据源管道就绪 |

## 四、红线清单（永不妥协）

- G3 内部市场是记账单位，**绝不通向代币/投机**；
- 三样东西不下放：种系审批（哪些 manifest 允许繁殖）、预算总闸、红线清单；
- 函数不出 RPC 边界；
- 诚实边界必须写进代码注释（链头需外锚、粗粒度 taint、上下文确定性）。

## 五、明确不做的事

| 不做 | 理由 |
|---|---|
| Postgres / Docker | 违背"单文件、5 分钟跑通"核心卖点 |
| 分布式日志 | 桌面场景单机，无需求 |
| 全量 WASM 沙箱 | host-call 10-100x 开销 + 生态兼容陡壁；ocap+taint 已取 80% 收益 |
| 自建语义向量索引 | BM25 够用，过万再上 embedding |
