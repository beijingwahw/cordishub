/**
 * @cordishub/core — meta-plugin for DeepSeek Harness
 *
 * 把 DSH 升级成完整工作台：插件市场 + 会话回放 + 成本仪表盘 + 多租户安全网。
 */

export { CordishubService, apply, type CordishubOptions, type CapabilityFlag, type DshEventMap } from './service.ts';
export { Storage, type StorageOptions } from './storage.ts';
export { CostEngine, DEEPSEEK_RATES, isValley, type ModelRate, type CostInput, type CostOutput } from './cost.ts';
export {
  ReplayEngine,
  type ReplayState,
  type DiffResult,
  type DiffOptions,
} from './replay.ts';
export { HubIndex, DEMO_PLUGINS, type PluginMeta, type SearchOptions } from './hub.ts';
export {
  SafetyNet,
  type SafetyPolicy,
  type SafetyViolation,
  type SafetyCheckResult,
  type MemoryGateScorer,
} from './safety.ts';
export type { Session, SessionCheckpoint, SessionEvent, EventSource, TokenUsage } from './types.ts';