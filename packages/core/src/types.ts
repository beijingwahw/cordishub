/**
 * CordisHub 事件 schema —— 严格遵循 DSH 的 append-only session log。
 *
 * DSH 的 session log 是一组连续的事件流，按"来源 (source)"分类：
 *   - system   : system prompt 与配置
 *   - reasoning: 模型推理 (thinking / chain-of-thought)
 *   - model    : 模型响应（assistant 输出，携带 token 统计）
 *   - tool     : tool call 与结果
 *   - subagent : 子 agent 调度
 *   - context  : 上下文注入
 *   - user     : 用户输入
 *   - meta     : 元事件（开始 / 结束 / checkpoint）
 */

export type EventSource =
  | 'system'
  | 'user'
  | 'reasoning'
  | 'model'
  | 'tool'
  | 'subagent'
  | 'context'
  | 'meta';

export interface SessionEvent {
  /** 事件唯一 ID（雪花 ID 形式） */
  id: string;
  /** 所属 session ID */
  sessionId: string;
  /** 来源 */
  source: EventSource;
  /** 时间戳（毫秒） */
  ts: number;
  /** 序号（在 session 内单调递增） */
  seq: number;
  /** 事件 payload（按 source 不同结构不同） */
  payload: Record<string, unknown>;
  /** 模型（如果是模型相关事件） */
  model?: string;
  /** 关联 tool call ID（如果是 tool 事件） */
  toolCallId?: string;
  /** 关联 subagent ID（如果是 subagent 事件） */
  subagentId?: string;
  /** token 统计（如果是模型事件） */
  tokens?: TokenUsage;
  /** 用户标签（用于 fork / bookmark） */
  tags?: string[];
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total: number;
}

export interface Session {
  id: string;
  startedAt: number;
  endedAt?: number;
  model: string;
  /** 总 token 消耗 */
  totalTokens: number;
  /** 总成本（USD） */
  totalCost: number;
  /** 关联的标签 */
  tags?: string[];
  /** 用户元数据 */
  meta?: Record<string, unknown>;
}

/**
 * 一个 session 的 checkpoint —— 用于 fork。
 * 类似 git commit，保存了截至该 event 的完整状态。
 */
export interface SessionCheckpoint {
  sessionId: string;
  eventId: string;
  seq: number;
  ts: number;
  /** 自定义 message，用于标注 */
  message?: string;
}