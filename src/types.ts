/**
 * Public type definitions for solana-smart-tx.
 *
 * Every type here is exported from the package root and forms the stable,
 * developer-facing API surface. Keep these types clean and well documented,
 * because they are what builders will see in their editor autocomplete.
 */

import type { Keypair, Transaction } from '@solana/web3.js';

/**
 * Constructor options for the {@link SmartTx} class.
 *
 * Only `rpcUrl` and `wallet` are required. Everything else has a sensible
 * default that works on Solana mainnet-beta with the free rule-based adapter.
 */
export interface SmartTxConfig {
  /** Helius or any Solana RPC endpoint. Required. */
  rpcUrl: string;
  /** Signing keypair used to sign every transaction. Required. */
  wallet: Keypair;
  /** Optional: enables gRPC slot streaming for faster, more accurate lifecycle tracking. */
  yellowstoneEndpoint?: string;
  /** Optional: auth token for the Yellowstone gRPC endpoint. */
  yellowstoneToken?: string;
  /** Optional: Jito block engine URL. Defaults to the mainnet block engine. */
  jitoRpcUrl?: string;
  /** Target network. Defaults to `mainnet-beta`. */
  network?: 'mainnet-beta' | 'devnet';
  /** Decision engine mode. Defaults to `rule-based` (no AI, no API key required). */
  mode?: 'rule-based' | 'ai';
  /** AI configuration. Required only when `mode` is `ai`. */
  aiConfig?: AIConfig;
  /** Optional: override the default tip guardrails. */
  tipConfig?: TipConfig;
  /** Optional: override the default retry behaviour. */
  retryConfig?: RetryConfig;
}

/**
 * Configuration for AI-powered tip and retry decisions.
 * Only used when {@link SmartTxConfig.mode} is `ai`.
 */
export interface AIConfig {
  /** LLM provider backing the AI adapter. */
  provider: 'groq' | 'anthropic';
  /** API key for the chosen provider. */
  apiKey: string;
  /** Model name. Defaults to `llama-3.3-70b-versatile` for Groq. */
  model?: string;
}

/**
 * Guardrails for tip amounts, expressed in lamports.
 * The adapter never proposes a tip outside the min/max range.
 */
export interface TipConfig {
  /** Floor for any tip. Default: 1000 lamports. */
  minLamports?: number;
  /** Ceiling for any tip. Default: 1000000 lamports. */
  maxLamports?: number;
  /** Percentile of the live tip distribution to target by default. Default: `p50`. */
  defaultPercentile?: 'p25' | 'p50' | 'p75' | 'p95';
}

/**
 * Controls automatic retry behaviour after a failed submission.
 */
export interface RetryConfig {
  /** Maximum number of retries before giving up. Default: 3. */
  maxRetries?: number;
  /** Base wait between retries in milliseconds. Default: 800. */
  baseWaitMs?: number;
  /** Cap on the exponential backoff wait in milliseconds. Default: 10000. */
  maxWaitMs?: number;
}

/**
 * Per-call options passed to {@link SmartTx.send}.
 */
export interface SendOptions {
  /** The built, unsigned transaction. `SmartTx` signs it for you. */
  transaction: Transaction;
  /** Lifecycle callback fired at every stage of submission. */
  onStatus?: (update: StatusUpdate) => void;
  /** Skip preflight simulation. Default: false. */
  skipPreflight?: boolean;
  /** Commitment level to confirm against. Default: `confirmed`. */
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

/**
 * Emitted through the {@link SendOptions.onStatus} callback at each lifecycle stage.
 */
export interface StatusUpdate {
  /** Current lifecycle stage. */
  stage: 'submitted' | 'processed' | 'confirmed' | 'finalized' | 'failed' | 'retrying';
  /** Human-readable description of what just happened. */
  message: string;
  /** Transaction signature, present once the transaction has been submitted. */
  signature?: string;
  /** Slot associated with the stage, when known. */
  slot?: number;
  /** Unix epoch milliseconds when this update was emitted. */
  timestamp: number;
  /** Current retry attempt, present during retry stages. */
  retryCount?: number;
}

/**
 * Final result returned by {@link SmartTx.send}. `send()` never throws;
 * it always resolves with one of these, whether the transaction landed or not.
 */
export interface SendResult {
  /** True if the transaction reached the requested commitment level. */
  landed: boolean;
  /** Transaction signature, present if the transaction was submitted. */
  signature?: string;
  /** Highest commitment level reached before returning. */
  finalStage?: 'processed' | 'confirmed' | 'finalized';
  /** Human-readable failure reason, present when `landed` is false. */
  reason?: string;
  /** What the builder or user should do next, present when `landed` is false. */
  suggestion?: string;
  /** Typed failure classification, present when `landed` is false. */
  failureType?: FailureType;
  /** Final tip used, in lamports. */
  tipUsed?: number;
  /** Total number of retries performed. */
  retryCount: number;
  /** Wall-clock duration of the entire `send()` call in milliseconds. */
  totalDurationMs: number;
  /** Slots recorded at each lifecycle stage. */
  slots?: {
    /** Slot at submission. */
    submitted: number;
    /** Slot at which the transaction was processed. */
    processed?: number;
    /** Slot at which the transaction was confirmed. */
    confirmed?: number;
    /** Slot at which the transaction was finalized. */
    finalized?: number;
  };
}

/**
 * All 15 classified failure types. Each maps to a human-readable message in
 * {@link FAILURE_MESSAGES} and a suggestion in {@link FAILURE_SUGGESTIONS}.
 */
export type FailureType =
  | 'EXPIRED_BLOCKHASH'
  | 'BLOCKHASH_NOT_FOUND'
  | 'INSUFFICIENT_FUNDS'
  | 'INSTRUCTION_ERROR'
  | 'SIMULATION_FAILED'
  | 'BUNDLE_DROPPED'
  | 'BUNDLE_REJECTED'
  | 'LEADER_NOT_AVAILABLE'
  | 'RATE_LIMITED'
  | 'ACCOUNT_NOT_FOUND'
  | 'COMPUTE_BUDGET_EXCEEDED'
  | 'DUPLICATE_TRANSACTION'
  | 'NETWORK_CONGESTION'
  | 'RPC_TIMEOUT'
  | 'UNKNOWN';

/**
 * Output of the {@link FailureClassifier}. Describes what went wrong, how
 * confident the classifier is, and the recommended recovery path.
 */
export interface FailureClassification {
  /** The classified failure type. */
  type: FailureType;
  /** Classifier confidence, from 0 to 1. */
  confidence: number;
  /** Technical explanation of the root cause. */
  rootCause: string;
  /** Recommended recovery strategy. */
  recoveryPath: 'retry_refresh_blockhash' | 'retry_raise_tip' | 'retry_wait' | 'abort';
  /** Suggested wait before the next attempt, in milliseconds. */
  waitMs: number;
  /** Plain English explanation of the reasoning behind the classification. */
  reasoning: string;
  /** What the builder or end user should do about it. */
  suggestion: string;
}

/**
 * Live network conditions captured at the time of submission. Builders can
 * fetch this via {@link SmartTx.getNetworkSnapshot} to show congestion in a UI.
 */
export interface NetworkSnapshot {
  /** Current slot. */
  slot: number;
  /** Rolling average slot time in milliseconds. */
  avgSlotTimeMs: number;
  /** Fraction of slots skipped in the observed window (0 to 1). */
  slotSkipRate: number;
  /** Jito tip floor distribution, in lamports. */
  tipPercentiles: {
    /** 25th percentile tip. */
    p25: number;
    /** 50th percentile (median) tip. */
    p50: number;
    /** 75th percentile tip. */
    p75: number;
    /** 95th percentile tip. */
    p95: number;
  };
  /** Derived congestion level. */
  congestionLevel: 'low' | 'medium' | 'high';
  /** True if a Jito leader is scheduled in the current window. */
  isJitoLeaderWindow: boolean;
  /** Estimated slots until the next Jito leader. */
  slotsUntilJitoLeader: number;
}

/**
 * Output of a tip adapter's `decideTip` method.
 */
export interface TipDecision {
  /** Final tip amount, in lamports. */
  lamports: number;
  /** Percentile the adapter targeted (for example, `p50`). */
  percentileUsed: string;
  /** Plain English explanation of how the tip was chosen. */
  reasoning: string;
  /** Multiplier applied on top of the base percentile value. */
  congestionMultiplier: number;
}

/**
 * Output of a retry adapter's `decideRetry` method.
 */
export interface RetryDecision {
  /** Whether the transaction should be retried. */
  shouldRetry: boolean;
  /** Tip to use on the next attempt, in lamports. */
  newTipLamports: number;
  /** How long to wait before retrying, in milliseconds. */
  waitMs: number;
  /** Whether the blockhash should be refreshed before retrying. */
  refreshBlockhash: boolean;
  /** Plain English explanation of the retry decision. */
  reasoning: string;
}
