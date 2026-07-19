/**
 * AI decision adapter for solana-smart-tx.
 *
 * This is a stub. It mirrors the shape of the rule-based adapter so the rest of
 * the package can depend on a stable interface, but the decision logic is not
 * implemented in this version. Selecting `mode: 'ai'` and calling a method here
 * throws a descriptive {@link NotImplementedError}.
 *
 * Contributions welcome: https://github.com/Focus1010/solana-smart-tx
 */

import type {
  AIConfig,
  NetworkSnapshot,
  RetryConfig,
  RetryDecision,
  TipConfig,
  TipDecision,
  FailureClassification,
} from '../types';

/** Message shown whenever an unimplemented AI method is invoked. */
const NOT_IMPLEMENTED_MESSAGE =
  "AI adapter is not yet implemented in this version. Set mode: 'rule-based' in " +
  'SmartTxConfig or contribute the AI adapter at github.com/Focus1010/solana-smart-tx';

/**
 * Error thrown by every {@link AIAdapter} method until the AI adapter ships.
 */
export class NotImplementedError extends Error {
  constructor(message: string = NOT_IMPLEMENTED_MESSAGE) {
    super(message);
    this.name = 'NotImplementedError';
    // Restore the prototype chain for correct `instanceof` checks after transpilation.
    Object.setPrototypeOf(this, NotImplementedError.prototype);
  }
}

/**
 * AI-powered decision adapter. Exposes the same surface as the rule-based
 * adapter (`decideTip` and `decideRetry`) so it can be swapped in transparently
 * once implemented.
 */
export class AIAdapter {
  private readonly config: AIConfig;

  /**
   * @param config - Provider, API key, and optional model for the AI backend.
   */
  constructor(config: AIConfig) {
    this.config = config;
  }

  /** The provider this adapter would call once implemented. */
  get provider(): AIConfig['provider'] {
    return this.config.provider;
  }

  /**
   * Would ask the configured LLM to choose a tip based on network conditions.
   *
   * @param _snapshot - Live network conditions.
   * @param _config - Tip guardrails.
   * @throws {NotImplementedError} Always, until the AI adapter is implemented.
   */
  decideTip(_snapshot: NetworkSnapshot, _config: TipConfig): TipDecision {
    throw new NotImplementedError();
  }

  /**
   * Would ask the configured LLM whether and how to retry a failed transaction.
   *
   * @param _failure - The classified failure.
   * @param _snapshot - Live network conditions.
   * @param _retryCount - How many retries have already happened.
   * @param _config - Retry guardrails.
   * @throws {NotImplementedError} Always, until the AI adapter is implemented.
   */
  decideRetry(
    _failure: FailureClassification,
    _snapshot: NetworkSnapshot,
    _retryCount: number,
    _config: RetryConfig,
  ): RetryDecision {
    throw new NotImplementedError();
  }
}
