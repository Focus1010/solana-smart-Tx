/**
 * solana-smart-tx - public package entry point.
 *
 * Everything a builder needs is re-exported from here, so imports stay flat:
 *
 * ```ts
 * import { SmartTx, FailureClassifier, DEFAULTS } from 'solana-smart-tx';
 * import type { SendResult, FailureType } from 'solana-smart-tx';
 * ```
 */

export { SmartTx } from './SmartTx';
export { FailureClassifier } from './classifier';
export type { ClassifierContext } from './classifier';
export * from './types';
export { DEFAULTS, FAILURE_MESSAGES, FAILURE_SUGGESTIONS } from './constants';
