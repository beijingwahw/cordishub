/**
 * @cordishub/core — meta-plugin for DeepSeek Harness
 *
 * 把 DSH 升级成完整工作台：插件市场 + 会话回放 + 成本仪表盘 + 多租户安全网。
 */

export { CordishubService, apply, type CordishubOptions, type CapabilityFlag, type DshEventMap } from './service.ts';
export { Storage, type StorageOptions } from './storage.ts';
export { escapeHtml, escapeRegExp } from './html.ts';
export {
  GENESIS,
  verifyFile,
  computeRoot,
  lineHash,
  sealHash,
  isSealRow,
  type SealRow,
  type VerifyReport,
} from './merkle.ts';
export {
  mintRoot,
  attenuate,
  assertTool,
  isExpired,
  CapabilityError,
  type Capability,
} from './capability.ts';
export {
  recordTape,
  verifyTape,
  playCounterfactual,
  bisectFirstBad,
  locateBadEvents,
  certifyDeterminism,
  stampSampling,
  type CassetteEntry,
  type CassetteTape,
  type TapeReport,
  type CfAction,
  type CfState,
  type CfStep,
  type CounterfactualModel,
  type FaultSpec,
  type CounterfactualResult,
  type BisectResult,
  type BadInterval,
  type ScanReport,
  type DeterminismCertificate,
} from './cassette.ts';
export {
  runReactor,
  evolve,
  seededRng,
  selectParents,
  genomeDistance,
  defaultCostOf,
  defaultFitness,
  type ReactorVariant,
  type ReactorRun,
  type ReactorReport,
  type ReactorFitness,
  type ReactorCostOf,
  type EvolutionReport,
  type SelectionStrategy,
} from './reactor.ts';
export {
  taintScan,
  cacheTaintCompatible,
  tenantTaintPolicy,
  TaintTracker,
  type TaintLabel,
  type TaintPolicy,
  type TaintReport,
  type TaintProvenance,
  type TaintViolation,
  type TaintTimelinePoint,
} from './taint.ts';
export {
  buildMethodTable,
  compileTaintPolicy,
  startRpcServer,
  rpcCall,
  type RpcHandler,
  type RpcMethodTable,
  type RpcServerHandle,
  type TaintPolicySpec,
} from './rpc.ts';
export {
  githubTopicFetcher,
  toPluginMeta,
  syncHubTopic,
  syncHubTopics,
  type GithubRepo,
  type RepoFetcher,
} from './hubsync.ts';
export { ResourceMarket, type MarketBid, type MarketGrant } from './market.ts';
export { CostEngine, DEEPSEEK_RATES, isValley, windowFactorAt, type ModelRate, type CostInput, type CostOutput, type ValleyWindow } from './cost.ts';
export { TariffSchedule, DEFAULT_TARIFF, type Tariff } from './tariff.ts';
export { BudgetLedger, BudgetExceededError, type LedgerEntry, type BudgetSnapshot } from './budget.ts';
export {
  extractGenomeFromSession,
  mutate,
  canonicalGenome,
  hashGenome,
  saveGenome,
  loadGenomes,
  fitnessOf,
  renderGenome,
  type AgentGenome,
  type SubagentSpec,
  type GenomeMutation,
  type GenomeFitness,
} from './genome.ts';
export {
  generateSigningKeyPair,
  signManifest,
  verifyManifest,
  hashManifest,
  canonicalManifest,
  diffCapabilities,
  renderCapabilityDiff,
  TrustRegistry,
  signData,
  verifyData,
  type PluginManifest,
  type CapabilityDiff,
  type SigningKeyPair,
  type TrustedKey,
  type PublisherEntry,
  type VerifyDecision,
} from './manifest.ts';
export {
  exportBundle,
  importBundle,
  verifyBundle,
  CommonsConsentError,
  CommonsVerifyError,
  type CommonsBundle,
  type CommonsConsent,
} from './commons.ts';
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