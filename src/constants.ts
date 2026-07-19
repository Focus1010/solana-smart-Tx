/**
 * Package-wide defaults and lookup tables for solana-smart-tx.
 *
 * These values are the tuned defaults from the underlying transaction stack.
 * Every one of them can be overridden through {@link SmartTxConfig}.
 */

/**
 * Default configuration values used across the package when the builder does
 * not override them in {@link SmartTxConfig}.
 */
export const DEFAULTS = {
  /** Default target network. */
  NETWORK: 'mainnet-beta',
  /** Default decision engine mode. */
  MODE: 'rule-based',
  /** Default Jito block engine URL. */
  JITO_RPC_URL: 'https://mainnet.block-engine.jito.wtf/api/v1',
  /** Floor for any proposed tip, in lamports. */
  TIP_MIN_LAMPORTS: 1000,
  /** Ceiling for any proposed tip, in lamports. */
  TIP_MAX_LAMPORTS: 1000000,
  /** Default tip percentile to target. */
  TIP_DEFAULT_PERCENTILE: 'p50',
  /** Default maximum number of retries. */
  MAX_RETRIES: 3,
  /** Default base wait between retries, in milliseconds. */
  BASE_WAIT_MS: 800,
  /** Cap on exponential backoff wait, in milliseconds. */
  MAX_WAIT_MS: 10000,
  /** Default commitment level to confirm against. */
  COMMITMENT: 'confirmed',
  /** How often to poll `getSlot()` when streaming is unavailable, in milliseconds. */
  SLOT_POLL_INTERVAL_MS: 400,
  /** How many slots a blockhash is considered viable for before refresh. */
  BLOCKHASH_REFRESH_SLOTS: 100,
  /** Safety margin in slots subtracted from blockhash validity. */
  BLOCKHASH_SAFETY_MARGIN: 2,
  /** How long a cached leader schedule entry stays valid, in milliseconds. */
  LEADER_CACHE_TTL_MS: 2000,
  /** Minimum spacing between rate-limited requests, in milliseconds. */
  RATE_LIMIT_MS: 1100,
} as const;

/**
 * Human-readable message for each {@link FailureType}.
 */
export const FAILURE_MESSAGES: Record<string, string> = {
  EXPIRED_BLOCKHASH: 'Blockhash expired before the transaction landed.',
  BLOCKHASH_NOT_FOUND: 'Blockhash was not found in the ledger.',
  INSUFFICIENT_FUNDS: 'Wallet does not have enough SOL to cover this transaction.',
  INSTRUCTION_ERROR: 'A program instruction failed on-chain.',
  SIMULATION_FAILED: 'Transaction failed preflight simulation.',
  BUNDLE_DROPPED: 'Jito bundle was dropped by the block engine.',
  BUNDLE_REJECTED: 'Jito bundle was rejected by the block engine.',
  LEADER_NOT_AVAILABLE: 'No Jito leader is scheduled in the current window.',
  RATE_LIMITED: 'RPC or block engine rate limit hit.',
  ACCOUNT_NOT_FOUND: 'A required account does not exist on-chain.',
  COMPUTE_BUDGET_EXCEEDED: 'Transaction exceeded its compute budget.',
  DUPLICATE_TRANSACTION: 'This transaction was already submitted.',
  NETWORK_CONGESTION: 'Network congestion caused the transaction to drop.',
  RPC_TIMEOUT: 'RPC did not respond within the timeout window.',
  UNKNOWN: 'An unclassified error occurred.',
};

/**
 * Actionable suggestion for each {@link FailureType}.
 */
export const FAILURE_SUGGESTIONS: Record<string, string> = {
  EXPIRED_BLOCKHASH: 'Retry with a fresh blockhash. Tip does not need to change.',
  BLOCKHASH_NOT_FOUND: 'Fetch a new blockhash from your primary RPC and retry.',
  INSUFFICIENT_FUNDS: 'Top up the wallet with SOL before retrying.',
  INSTRUCTION_ERROR: 'Do not retry. Check your program logic and transaction accounts.',
  SIMULATION_FAILED: 'Do not retry. Fix the transaction before resubmitting.',
  BUNDLE_DROPPED: 'Retry with a higher tip during the next Jito leader window.',
  BUNDLE_REJECTED: 'Check bundle structure and tip account validity before retrying.',
  LEADER_NOT_AVAILABLE: 'Wait for the next Jito leader window and retry.',
  RATE_LIMITED: 'Wait a few seconds and retry with exponential backoff.',
  ACCOUNT_NOT_FOUND: 'Do not retry. Verify all account addresses in the transaction.',
  COMPUTE_BUDGET_EXCEEDED: 'Increase compute unit limit in your transaction and retry.',
  DUPLICATE_TRANSACTION: 'Do not retry. This transaction already exists on-chain.',
  NETWORK_CONGESTION: 'Retry with a higher tip. Network is congested.',
  RPC_TIMEOUT: 'Switch to a backup RPC endpoint and retry.',
  UNKNOWN: 'Inspect the raw error and retry once. If it fails again, abort.',
};
