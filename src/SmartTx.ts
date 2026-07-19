/**
 * SmartTx - the entire developer-facing API for solana-smart-tx.
 *
 * Give it a built transaction and it handles tip selection, submission
 * (Jito bundle or standard RPC), lifecycle tracking, failure classification,
 * and retry - then hands back a single {@link SendResult}. `send()` never
 * throws; it always resolves with a result you can act on.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type Commitment,
  type TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';

import type {
  AIConfig,
  NetworkSnapshot,
  RetryConfig,
  RetryDecision,
  SendOptions,
  SendResult,
  SmartTxConfig,
  StatusUpdate,
  TipConfig,
  TipDecision,
  FailureClassification,
} from './types';
import { DEFAULTS } from './constants';
import { FailureClassifier, type ClassifierContext } from './classifier';
import { decideTip as ruleDecideTip, decideRetry as ruleDecideRetry } from './adapters/rule-based';
import { AIAdapter } from './adapters/ai';

/**
 * Internal decision-adapter shape shared by the rule-based and AI adapters.
 * Normalizing to this interface lets `SmartTx` swap engines transparently.
 */
interface DecisionAdapter {
  decideTip(snapshot: NetworkSnapshot, config: TipConfig): TipDecision;
  decideRetry(
    failure: FailureClassification,
    snapshot: NetworkSnapshot,
    retryCount: number,
    config: RetryConfig,
  ): RetryDecision;
}

/**
 * Known Jito mainnet tip accounts. A tip transfer to one of these is required
 * for a bundle to be considered by the block engine auction.
 */
const JITO_TIP_ACCOUNTS: string[] = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

/** Ordering of commitment levels, lowest to highest. */
const COMMITMENT_RANK: Record<'processed' | 'confirmed' | 'finalized', number> = {
  processed: 0,
  confirmed: 1,
  finalized: 2,
};

/** Sleeps for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Extracts a plain string message from an unknown thrown value. */
function errToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Main entry point of the package.
 *
 * @example
 * ```ts
 * const smart = new SmartTx({ rpcUrl, wallet });
 * const result = await smart.send({ transaction, onStatus: console.log });
 * if (!result.landed) console.error(result.reason, result.suggestion);
 * await smart.disconnect();
 * ```
 */
export class SmartTx {
  private readonly connection: Connection;
  private readonly config: SmartTxConfig;
  private readonly network: 'mainnet-beta' | 'devnet';
  private readonly jitoRpcUrl: string;
  private readonly tipConfig: TipConfig;
  private readonly retryConfig: RetryConfig;
  private readonly adapter: DecisionAdapter;
  private readonly classifier: FailureClassifier;

  /** Rolling record of observed slots and the wall-clock time they were seen. */
  private readonly slotSamples: Array<{ slot: number; t: number }> = [];

  /**
   * @param config - Connection, wallet, and behaviour overrides. Only `rpcUrl`
   *   and `wallet` are required; everything else falls back to package defaults.
   */
  constructor(config: SmartTxConfig) {
    this.config = config;
    this.network = config.network ?? (DEFAULTS.NETWORK as 'mainnet-beta');
    this.jitoRpcUrl = config.jitoRpcUrl ?? DEFAULTS.JITO_RPC_URL;
    this.tipConfig = config.tipConfig ?? {};
    this.retryConfig = config.retryConfig ?? {};
    this.classifier = new FailureClassifier();

    this.connection = new Connection(config.rpcUrl, {
      commitment: DEFAULTS.COMMITMENT as Commitment,
    });

    const mode = config.mode ?? (DEFAULTS.MODE as 'rule-based');
    if (mode === 'ai') {
      const aiConfig: AIConfig | undefined = config.aiConfig;
      if (!aiConfig) {
        throw new Error("mode 'ai' requires an aiConfig with a provider and apiKey.");
      }
      this.adapter = new AIAdapter(aiConfig);
    } else {
      // Rule-based adapter: wrap the standalone functions in the shared shape.
      this.adapter = {
        decideTip: ruleDecideTip,
        decideRetry: ruleDecideRetry,
      };
    }
  }

  /**
   * Submits a transaction and manages its full lifecycle: tip selection,
   * submission, confirmation tracking, failure classification, and retry.
   *
   * This method never throws. On any failure it resolves with a
   * {@link SendResult} where `landed` is false and `reason`/`suggestion` are
   * populated.
   *
   * @param options - The transaction to send plus per-call preferences.
   * @returns A {@link SendResult} describing the final outcome.
   */
  async send(options: SendOptions): Promise<SendResult> {
    const start = Date.now();
    const targetCommitment = options.commitment ?? (DEFAULTS.COMMITMENT as 'confirmed');
    const emit = (update: StatusUpdate): void => {
      try {
        options.onStatus?.(update);
      } catch {
        // A misbehaving callback must never break the send loop.
      }
    };

    // Snapshot the instructions once so each attempt can rebuild cleanly.
    const baseInstructions: TransactionInstruction[] = [...options.transaction.instructions];

    let retryCount = 0;
    let tipUsed = 0;
    let lastSignature: string | undefined;
    const slots: NonNullable<SendResult['slots']> = { submitted: 0 };

    let snapshot: NetworkSnapshot;
    let tipDecision: TipDecision;
    try {
      // Step 1: fetch live network conditions.
      snapshot = await this.getNetworkSnapshot();
      // Step 2: decide the tip.
      tipDecision = this.adapter.decideTip(snapshot, this.tipConfig);
      tipUsed = tipDecision.lamports;
    } catch (err) {
      // If we cannot even read the network, fail gracefully rather than throw.
      const failure = this.classifyError(errToString(err));
      return this.buildFailure(failure, retryCount, tipUsed, start, lastSignature, slots);
    }

    // Main submit/confirm/retry loop.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let signature: string | undefined;
      let lastValidBlockHeight = 0;
      const useBundle = this.network === 'mainnet-beta' && snapshot.isJitoLeaderWindow;

      try {
        // Step 3: build and sign a fresh transaction for this attempt.
        const built = await this.buildAndSign(baseInstructions, tipUsed, useBundle, targetCommitment);
        signature = built.signature;
        lastValidBlockHeight = built.lastValidBlockHeight;
        lastSignature = signature;

        // Step 4: submit via Jito bundle if in a leader window, else standard RPC.
        if (useBundle) {
          await this.submitBundle(built.rawTransaction);
        } else {
          await this.submitStandard(built.rawTransaction, options.skipPreflight ?? false);
        }

        const submittedSlot = snapshot.slot;
        slots.submitted = submittedSlot;
        emit({
          stage: 'submitted',
          message: useBundle
            ? `Submitted as a Jito bundle with a ${tipUsed} lamport tip.`
            : `Submitted via standard RPC with a ${tipUsed} lamport priority tip.`,
          signature,
          slot: submittedSlot,
          timestamp: Date.now(),
          retryCount,
        });

        // Step 5: track the lifecycle and fire onStatus at each stage.
        const finalStage = await this.pollLifecycle(
          signature,
          targetCommitment,
          lastValidBlockHeight,
          retryCount,
          slots,
          emit,
        );

        // Success.
        return {
          landed: true,
          signature,
          finalStage,
          tipUsed,
          retryCount,
          totalDurationMs: Date.now() - start,
          slots,
        };
      } catch (err) {
        // Step 6: classify the failure and decide whether to retry.
        const message = errToString(err);
        const failure = this.buildClassification(message, retryCount, tipUsed, snapshot);

        emit({
          stage: 'failed',
          message: `${failure.reasoning} ${failure.suggestion}`,
          signature,
          timestamp: Date.now(),
          retryCount,
        });

        const decision = this.adapter.decideRetry(failure, snapshot, retryCount, this.retryConfig);
        if (!decision.shouldRetry) {
          return this.buildFailure(failure, retryCount, tipUsed, start, lastSignature, slots);
        }

        // Step 7: prepare the retry.
        retryCount += 1;
        tipUsed = decision.newTipLamports > 0 ? decision.newTipLamports : tipUsed;
        emit({
          stage: 'retrying',
          message: `${decision.reasoning} Waiting ${decision.waitMs}ms before attempt ${retryCount + 1}.`,
          signature,
          timestamp: Date.now(),
          retryCount,
        });

        await sleep(decision.waitMs);

        // Refresh network conditions before looping. A fresh blockhash is
        // fetched unconditionally inside buildAndSign on the next iteration.
        try {
          snapshot = await this.getNetworkSnapshot();
        } catch {
          // Keep the previous snapshot if the refresh fails; the loop can still proceed.
        }
      }
    }
  }

  /**
   * Fetches current network conditions: slot, rolling average slot time, tip
   * floor percentiles, derived congestion level, and an estimated Jito leader
   * window. Builders can call this to show congestion in a UI before sending.
   *
   * Degrades gracefully: if the Jito tip API is unavailable it falls back to
   * `getRecentPrioritizationFees`.
   *
   * @returns A {@link NetworkSnapshot} describing conditions right now.
   */
  async getNetworkSnapshot(): Promise<NetworkSnapshot> {
    const slot = await this.connection.getSlot(DEFAULTS.COMMITMENT as Commitment);

    // Maintain a rolling 10-sample window to estimate average slot time.
    const now = Date.now();
    this.slotSamples.push({ slot, t: now });
    while (this.slotSamples.length > 10) this.slotSamples.shift();
    const avgSlotTimeMs = this.computeAvgSlotTime();

    const tipPercentiles = await this.fetchTipPercentiles();

    // Derive congestion from the p75/p50 ratio.
    const ratio = tipPercentiles.p50 > 0 ? tipPercentiles.p75 / tipPercentiles.p50 : 1;
    let congestionLevel: NetworkSnapshot['congestionLevel'];
    if (ratio < 1.5) congestionLevel = 'low';
    else if (ratio <= 2.5) congestionLevel = 'medium';
    else congestionLevel = 'high';

    // Leader window is approximated for this scaffold. Real Jito leader-schedule
    // and Yellowstone slot-stream integration are on the roadmap.
    const slotsUntilJitoLeader = 8 - (slot % 8);
    const isJitoLeaderWindow = this.network === 'mainnet-beta' && slotsUntilJitoLeader <= 2;

    return {
      slot,
      avgSlotTimeMs,
      slotSkipRate: 0,
      tipPercentiles,
      congestionLevel,
      isJitoLeaderWindow,
      slotsUntilJitoLeader,
    };
  }

  /**
   * Classifies a raw error string into a typed {@link FailureClassification}.
   * Useful for diagnosing past failures outside of a live `send()` call.
   *
   * @param errorMessage - The raw error text to classify.
   * @returns A typed classification with a reason and an actionable suggestion.
   */
  classifyError(errorMessage: string): FailureClassification {
    return this.classifier.classify(errorMessage, {
      retryCount: 0,
      blockhashAge: 0,
      tipLamports: 0,
      tipP75Lamports: 0,
      streamSaysConfirmed: false,
      rpcConfirmed: false,
    });
  }

  /**
   * Closes any open gRPC streams and releases resources. Safe to call more than
   * once. Call this on process exit.
   */
  async disconnect(): Promise<void> {
    // No persistent streams are opened in this scaffold (RPC polling only).
    // This is where a Yellowstone gRPC subscription would be torn down.
    this.slotSamples.length = 0;
  }

  // --- internals -----------------------------------------------------------

  /**
   * Builds a classifier context from live state and classifies the message.
   */
  private buildClassification(
    message: string,
    retryCount: number,
    tipLamports: number,
    snapshot: NetworkSnapshot,
  ): FailureClassification {
    const context: ClassifierContext = {
      retryCount,
      blockhashAge: 0,
      tipLamports,
      tipP75Lamports: snapshot.tipPercentiles.p75,
      streamSaysConfirmed: false,
      rpcConfirmed: false,
    };
    return this.classifier.classify(message, context);
  }

  /**
   * Assembles a failed {@link SendResult} from a classification.
   */
  private buildFailure(
    failure: FailureClassification,
    retryCount: number,
    tipUsed: number,
    start: number,
    signature: string | undefined,
    slots: NonNullable<SendResult['slots']>,
  ): SendResult {
    return {
      landed: false,
      signature,
      reason: failure.reasoning,
      suggestion: failure.suggestion,
      failureType: failure.type,
      tipUsed,
      retryCount,
      totalDurationMs: Date.now() - start,
      slots: slots.submitted > 0 ? slots : undefined,
    };
  }

  /** Computes the average slot time in ms from the rolling sample window. */
  private computeAvgSlotTime(): number {
    if (this.slotSamples.length < 2) return DEFAULTS.SLOT_POLL_INTERVAL_MS;
    const first = this.slotSamples[0];
    const last = this.slotSamples[this.slotSamples.length - 1];
    const slotDelta = last.slot - first.slot;
    const timeDelta = last.t - first.t;
    if (slotDelta <= 0) return DEFAULTS.SLOT_POLL_INTERVAL_MS;
    return Math.round(timeDelta / slotDelta);
  }

  /**
   * Fetches tip-floor percentiles (in lamports) from the Jito tip API, falling
   * back to `getRecentPrioritizationFees` if that request fails.
   */
  private async fetchTipPercentiles(): Promise<NetworkSnapshot['tipPercentiles']> {
    try {
      const res = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor');
      if (!res.ok) throw new Error(`tip_floor HTTP ${res.status}`);
      const data = (await res.json()) as Array<Record<string, number>>;
      const row = data[0];
      if (!row) throw new Error('tip_floor returned no rows');
      const toLamports = (sol: number | undefined): number => Math.round((sol ?? 0) * 1e9);
      const p25 = toLamports(row.landed_tips_25th_percentile);
      const p50 = toLamports(row.landed_tips_50th_percentile);
      const p75 = toLamports(row.landed_tips_75th_percentile);
      const p95 = toLamports(row.landed_tips_95th_percentile);
      // Guard against an all-zero payload, which would break congestion math.
      if (p50 > 0) return { p25, p50, p75, p95 };
      throw new Error('tip_floor percentiles were empty');
    } catch {
      return this.fallbackTipPercentiles();
    }
  }

  /**
   * Derives rough tip percentiles from recent prioritization fees when the Jito
   * tip API is unavailable.
   */
  private async fallbackTipPercentiles(): Promise<NetworkSnapshot['tipPercentiles']> {
    try {
      const fees = await this.connection.getRecentPrioritizationFees();
      const values = fees
        .map((f) => f.prioritizationFee)
        .filter((v) => v > 0)
        .sort((a, b) => a - b);
      if (values.length === 0) {
        // Nothing to go on: return the configured floor across the board.
        const floor = this.tipConfig.minLamports ?? DEFAULTS.TIP_MIN_LAMPORTS;
        return { p25: floor, p50: floor, p75: floor, p95: floor };
      }
      const at = (q: number): number => values[Math.min(values.length - 1, Math.floor(q * values.length))];
      return { p25: at(0.25), p50: at(0.5), p75: at(0.75), p95: at(0.95) };
    } catch {
      const floor = this.tipConfig.minLamports ?? DEFAULTS.TIP_MIN_LAMPORTS;
      return { p25: floor, p50: floor, p75: floor, p95: floor };
    }
  }

  /**
   * Builds a fresh transaction from the base instructions, attaching a Jito tip
   * transfer when submitting as a bundle, then signs it with the wallet.
   */
  private async buildAndSign(
    baseInstructions: TransactionInstruction[],
    tipLamports: number,
    useBundle: boolean,
    commitment: Commitment,
  ): Promise<{ signature: string; rawTransaction: Buffer; lastValidBlockHeight: number }> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(commitment);

    const tx = new Transaction();
    tx.add(...baseInstructions);

    // A bundle only lands if it pays a tip to a Jito tip account.
    if (useBundle && tipLamports > 0) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: this.config.wallet.publicKey,
          toPubkey: new PublicKey(this.pickTipAccount()),
          lamports: tipLamports,
        }),
      );
    }

    tx.recentBlockhash = blockhash;
    tx.feePayer = this.config.wallet.publicKey;
    tx.sign(this.config.wallet);

    const sig = tx.signature;
    if (!sig) throw new Error('Transaction signing failed: no signature produced.');

    return {
      signature: bs58.encode(sig),
      rawTransaction: tx.serialize(),
      lastValidBlockHeight,
    };
  }

  /** Picks a Jito tip account at random to spread load across the set. */
  private pickTipAccount(): string {
    const idx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return JITO_TIP_ACCOUNTS[idx];
  }

  /**
   * Submits a serialized transaction as a single-transaction Jito bundle via the
   * block engine JSON-RPC endpoint.
   */
  private async submitBundle(rawTransaction: Buffer): Promise<void> {
    const encoded = bs58.encode(rawTransaction);
    const res = await fetch(`${this.jitoRpcUrl}/bundles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [[encoded]],
      }),
    });

    if (!res.ok) {
      throw new Error(`Jito bundle dropped: block engine returned HTTP ${res.status}.`);
    }
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error) {
      throw new Error(`Jito bundle rejected: ${body.error.message ?? 'unknown block engine error'}.`);
    }
  }

  /**
   * Submits a serialized transaction via standard RPC `sendRawTransaction`.
   */
  private async submitStandard(rawTransaction: Buffer, skipPreflight: boolean): Promise<void> {
    await this.connection.sendRawTransaction(rawTransaction, {
      skipPreflight,
      preflightCommitment: DEFAULTS.COMMITMENT as Commitment,
      maxRetries: 0,
    });
  }

  /**
   * Polls signature status until the target commitment is reached, firing the
   * onStatus callback as each new stage is observed. Throws if the transaction
   * errors on-chain or its blockhash expires before landing.
   */
  private async pollLifecycle(
    signature: string,
    target: 'processed' | 'confirmed' | 'finalized',
    lastValidBlockHeight: number,
    retryCount: number,
    slots: NonNullable<SendResult['slots']>,
    emit: (update: StatusUpdate) => void,
  ): Promise<'processed' | 'confirmed' | 'finalized'> {
    const targetRank = COMMITMENT_RANK[target];
    let highestRank = -1;

    // Bound the wait so a silently dropped transaction cannot hang forever.
    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
      const { value } = await this.connection.getSignatureStatuses([signature]);
      const status = value[0];

      if (status) {
        if (status.err) {
          throw new Error(`Instruction error on-chain: ${JSON.stringify(status.err)}`);
        }
        const level = (status.confirmationStatus ?? 'processed') as
          | 'processed'
          | 'confirmed'
          | 'finalized';
        const rank = COMMITMENT_RANK[level];

        if (rank > highestRank) {
          highestRank = rank;
          this.recordStageSlot(level, status.slot, slots);
          emit({
            stage: level,
            message: this.stageMessage(level),
            signature,
            slot: status.slot,
            timestamp: Date.now(),
            retryCount,
          });
        }

        if (rank >= targetRank) return level;
      } else {
        // Not yet visible. If the blockhash has expired, stop waiting.
        const blockHeight = await this.connection.getBlockHeight(DEFAULTS.COMMITMENT as Commitment);
        if (blockHeight > lastValidBlockHeight) {
          throw new Error('Transaction blockhash has expired before the transaction landed.');
        }
      }

      await sleep(DEFAULTS.SLOT_POLL_INTERVAL_MS);
    }

    throw new Error('RPC timeout: the transaction did not reach the target commitment in time.');
  }

  /** Records the slot at which a given lifecycle stage was reached. */
  private recordStageSlot(
    level: 'processed' | 'confirmed' | 'finalized',
    slot: number,
    slots: NonNullable<SendResult['slots']>,
  ): void {
    if (level === 'processed') slots.processed = slot;
    else if (level === 'confirmed') slots.confirmed = slot;
    else slots.finalized = slot;
  }

  /** Human-readable message for a lifecycle stage. */
  private stageMessage(level: 'processed' | 'confirmed' | 'finalized'): string {
    switch (level) {
      case 'processed':
        return 'Transaction was processed by a validator (not yet confirmed).';
      case 'confirmed':
        return 'Transaction is confirmed by a supermajority of the cluster.';
      case 'finalized':
      default:
        return 'Transaction is finalized and irreversible.';
    }
  }
}
