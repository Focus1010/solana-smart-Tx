/**
 * Failure classifier for solana-smart-tx.
 *
 * Turns a raw error string (from an RPC, the Jito block engine, or a caught
 * exception) into a typed {@link FailureClassification} that tells the caller
 * what went wrong, why, and what to do next.
 *
 * This is the same 15-type logic used in the underlying transaction stack,
 * exposed here as a clean, dependency-free class with an added `suggestion`
 * field on every result.
 */

import type { FailureClassification, FailureType } from '../types';
import { FAILURE_MESSAGES, FAILURE_SUGGESTIONS } from '../constants';

/**
 * Context passed alongside the raw error message. These signals let the
 * classifier disambiguate cases that share similar error text (for example,
 * distinguishing an expired blockhash from a network drop).
 */
export interface ClassifierContext {
  /** How many times this transaction has already been retried. */
  retryCount: number;
  /** Age of the blockhash in slots at the time of failure. */
  blockhashAge: number;
  /** Tip that was attached to the failed attempt, in lamports. */
  tipLamports: number;
  /** The current p75 tip floor, in lamports. */
  tipP75Lamports: number;
  /** True if a slot stream reported the transaction as confirmed. */
  streamSaysConfirmed: boolean;
  /** True if the RPC reported the transaction as confirmed. */
  rpcConfirmed: boolean;
}

/**
 * Maps a {@link FailureType} to the recovery path the retry adapter should take.
 */
const RECOVERY_PATHS: Record<FailureType, FailureClassification['recoveryPath']> = {
  EXPIRED_BLOCKHASH: 'retry_refresh_blockhash',
  BLOCKHASH_NOT_FOUND: 'retry_refresh_blockhash',
  INSUFFICIENT_FUNDS: 'abort',
  INSTRUCTION_ERROR: 'abort',
  SIMULATION_FAILED: 'abort',
  BUNDLE_DROPPED: 'retry_raise_tip',
  BUNDLE_REJECTED: 'abort',
  LEADER_NOT_AVAILABLE: 'retry_wait',
  RATE_LIMITED: 'retry_wait',
  ACCOUNT_NOT_FOUND: 'abort',
  COMPUTE_BUDGET_EXCEEDED: 'abort',
  DUPLICATE_TRANSACTION: 'abort',
  NETWORK_CONGESTION: 'retry_raise_tip',
  RPC_TIMEOUT: 'retry_wait',
  UNKNOWN: 'retry_wait',
};

/**
 * Default wait (in milliseconds) suggested for each failure type. The retry
 * adapter is free to override this with its own backoff schedule.
 */
const DEFAULT_WAIT_MS: Record<FailureType, number> = {
  EXPIRED_BLOCKHASH: 0,
  BLOCKHASH_NOT_FOUND: 0,
  INSUFFICIENT_FUNDS: 0,
  INSTRUCTION_ERROR: 0,
  SIMULATION_FAILED: 0,
  BUNDLE_DROPPED: 500,
  BUNDLE_REJECTED: 0,
  LEADER_NOT_AVAILABLE: 800,
  RATE_LIMITED: 1500,
  ACCOUNT_NOT_FOUND: 0,
  COMPUTE_BUDGET_EXCEEDED: 0,
  DUPLICATE_TRANSACTION: 0,
  NETWORK_CONGESTION: 800,
  RPC_TIMEOUT: 1000,
  UNKNOWN: 800,
};

/**
 * A single pattern rule. If `test` matches the lowercased error message, the
 * associated `type` and `confidence` are used.
 */
interface PatternRule {
  type: FailureType;
  test: RegExp;
  confidence: number;
  /** Technical root-cause explanation for this rule. */
  rootCause: string;
}

/**
 * Ordered list of pattern rules. Order matters: the first match wins, so more
 * specific patterns are listed before broader ones.
 */
const PATTERN_RULES: PatternRule[] = [
  {
    type: 'EXPIRED_BLOCKHASH',
    test: /block\s?height exceeded|blockhash.*expired|transaction expired|has expired/i,
    confidence: 0.95,
    rootCause: 'The recent blockhash referenced by the transaction is older than the last valid block height, so validators will no longer accept it.',
  },
  {
    type: 'BLOCKHASH_NOT_FOUND',
    test: /blockhash not found|invalid blockhash/i,
    confidence: 0.9,
    rootCause: 'The blockhash was not present in the validator ledger, usually because it was fetched from a lagging or forked RPC.',
  },
  {
    type: 'INSUFFICIENT_FUNDS',
    test: /insufficient (funds|lamports)|debit an account but found no record|attempt to debit/i,
    confidence: 0.95,
    rootCause: 'The fee payer or a source account does not hold enough lamports to cover the transfer plus fees and rent.',
  },
  {
    type: 'COMPUTE_BUDGET_EXCEEDED',
    test: /compute budget exceeded|exceeded (cus|compute units)|computational budget/i,
    confidence: 0.9,
    rootCause: 'Execution consumed more compute units than the transaction requested, so the runtime aborted it.',
  },
  {
    type: 'ACCOUNT_NOT_FOUND',
    test: /account not found|could not find account|accountnotfound|uninitialized account/i,
    confidence: 0.85,
    rootCause: 'An account referenced by an instruction does not exist on-chain (for example, a token account that was never created).',
  },
  {
    type: 'SIMULATION_FAILED',
    test: /simulation failed|failed to simulate|preflight/i,
    confidence: 0.8,
    rootCause: 'Preflight simulation rejected the transaction before it was ever broadcast.',
  },
  {
    type: 'INSTRUCTION_ERROR',
    test: /custom program error|instruction error|program failed to complete|error processing instruction/i,
    confidence: 0.85,
    rootCause: 'A program returned an error while processing one of the instructions in the transaction.',
  },
  {
    type: 'DUPLICATE_TRANSACTION',
    test: /already (been )?processed|duplicate (signature|transaction)|this transaction has already/i,
    confidence: 0.9,
    rootCause: 'A transaction with this exact signature has already landed, so the network rejected the resubmission.',
  },
  {
    type: 'BUNDLE_REJECTED',
    test: /bundle rejected|bundle.*invalid|rejected by block engine/i,
    confidence: 0.85,
    rootCause: 'The Jito block engine rejected the bundle, usually due to a malformed tip instruction or invalid tip account.',
  },
  {
    type: 'BUNDLE_DROPPED',
    test: /bundle.*dropped|bundle not landed|bundle timed out|bundle expired/i,
    confidence: 0.8,
    rootCause: 'The bundle was accepted but never landed, typically because the tip was too low to win the auction.',
  },
  {
    type: 'LEADER_NOT_AVAILABLE',
    test: /no (jito )?leader|leader not available|no leader scheduled|not a leader/i,
    confidence: 0.8,
    rootCause: 'No Jito-enabled leader is scheduled in the current slot window, so a bundle cannot be included right now.',
  },
  {
    type: 'RATE_LIMITED',
    test: /rate limit|too many requests|429|throttl/i,
    confidence: 0.9,
    rootCause: 'The RPC or block engine returned a rate-limit response, so requests are being throttled.',
  },
  {
    type: 'RPC_TIMEOUT',
    test: /time ?out|timed out|etimedout|request timeout|deadline exceeded|econnreset|network (request )?failed|fetch failed/i,
    confidence: 0.75,
    rootCause: 'The RPC did not respond within the allotted time, so the outcome of the submission is unknown.',
  },
  {
    type: 'NETWORK_CONGESTION',
    test: /congest|node is behind|slot skipped|dropped|not confirmed/i,
    confidence: 0.6,
    rootCause: 'The transaction was likely dropped under load before it could be included in a block.',
  },
];

/**
 * Classifies raw Solana transaction errors into typed, actionable failures.
 *
 * @example
 * ```ts
 * const classifier = new FailureClassifier();
 * const result = classifier.classify('Blockhash not found', context);
 * console.log(result.type);       // 'BLOCKHASH_NOT_FOUND'
 * console.log(result.suggestion); // 'Fetch a new blockhash ...'
 * ```
 */
export class FailureClassifier {
  /**
   * Classifies a raw error message into a {@link FailureClassification}.
   *
   * @param errorMessage - The raw error string from an RPC, the block engine,
   *   or a caught exception. May be empty.
   * @param context - Signals about the failed attempt used to disambiguate
   *   otherwise-similar errors.
   * @returns A typed classification with a human-readable reason, a recovery
   *   path, a wait hint, and an actionable suggestion.
   */
  classify(errorMessage: string, context: ClassifierContext): FailureClassification {
    const message = (errorMessage ?? '').toString();
    const normalized = message.toLowerCase().trim();

    // Special case: the stream or RPC already saw a confirmation. Any error we
    // caught afterwards is almost certainly a benign duplicate resubmission.
    if (context.streamSaysConfirmed || context.rpcConfirmed) {
      return this.build(
        'DUPLICATE_TRANSACTION',
        0.85,
        'A confirmation was observed for this transaction, so the error is from a redundant resubmission rather than a real failure.',
        `A confirmation signal already arrived (${context.streamSaysConfirmed ? 'stream' : 'RPC'}), so this transaction most likely landed.`,
      );
    }

    // Find the first matching pattern rule.
    const match = PATTERN_RULES.find((rule) => rule.test.test(normalized));

    if (match) {
      let { type, confidence, rootCause } = match;

      // Context-based refinement: an "expired-looking" error on a very fresh
      // blockhash is more likely a congestion drop than a true expiry.
      if (type === 'EXPIRED_BLOCKHASH' && context.blockhashAge < 30) {
        type = 'NETWORK_CONGESTION';
        confidence = 0.6;
        rootCause =
          'The error resembled an expired blockhash, but the blockhash was still young, which points to a congestion drop instead.';
      }

      // If a bundle dropped and the tip was already at or above p75, congestion
      // is the more useful framing than a simple "raise the tip" bundle drop.
      if (type === 'BUNDLE_DROPPED' && context.tipLamports >= context.tipP75Lamports && context.tipP75Lamports > 0) {
        type = 'NETWORK_CONGESTION';
        confidence = 0.65;
        rootCause =
          'The bundle dropped even though the tip was already at the p75 floor, which indicates broad network congestion rather than an underbid.';
      }

      return this.build(type, confidence, rootCause, this.reasonFor(type, context));
    }

    // No pattern matched.
    return this.build(
      'UNKNOWN',
      0.3,
      'The error text did not match any known failure signature.',
      'The error did not match any known pattern, so it is being treated as an unclassified failure.',
    );
  }

  /**
   * Builds a complete {@link FailureClassification} from a type, wiring in the
   * shared message and suggestion tables.
   */
  private build(
    type: FailureType,
    confidence: number,
    rootCause: string,
    reasoning: string,
  ): FailureClassification {
    return {
      type,
      confidence,
      rootCause,
      recoveryPath: RECOVERY_PATHS[type],
      waitMs: DEFAULT_WAIT_MS[type],
      reasoning,
      suggestion: FAILURE_SUGGESTIONS[type] ?? FAILURE_SUGGESTIONS.UNKNOWN,
    };
  }

  /**
   * Produces a plain-English reasoning line for a classified type, folding in
   * the shared human-readable message and light context where useful.
   */
  private reasonFor(type: FailureType, context: ClassifierContext): string {
    const base = FAILURE_MESSAGES[type] ?? FAILURE_MESSAGES.UNKNOWN;
    if (context.retryCount > 0) {
      return `${base} This was attempt ${context.retryCount + 1}.`;
    }
    return base;
  }
}
