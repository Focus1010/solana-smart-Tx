/**
 * basic-send.ts - the smallest complete example.
 *
 * Sends a tiny SOL transfer from the wallet to itself, streams every lifecycle
 * stage to the console, and prints the final result. Run it with:
 *
 *   npm run example:basic
 *
 * Requires a .env file with RPC_URL and WALLET_PRIVATE_KEY (see .env.example).
 */

import 'dotenv/config';
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { SmartTx, type StatusUpdate, type SendResult } from '../src';

async function main(): Promise<void> {
  // 1. Load config from the environment.
  const rpcUrl = process.env.RPC_URL;
  const secret = process.env.WALLET_PRIVATE_KEY;
  if (!rpcUrl || !secret) throw new Error('Set RPC_URL and WALLET_PRIVATE_KEY in your .env file.');

  // 2. Rebuild the signing keypair from a base58 secret key.
  const wallet = Keypair.fromSecretKey(bs58.decode(secret));

  // 3. Build a simple 0.000001 SOL self-transfer (a safe no-op payment).
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wallet.publicKey,
      lamports: Math.round(0.000001 * LAMPORTS_PER_SOL),
    }),
  );

  // 4. Instantiate SmartTx with the default rule-based adapter.
  const smart = new SmartTx({ rpcUrl, wallet, network: 'mainnet-beta' });

  // 5. Send, logging each lifecycle stage as it happens.
  const result: SendResult = await smart.send({
    transaction,
    onStatus: (u: StatusUpdate) =>
      console.log(`[${new Date(u.timestamp).toISOString()}] ${u.stage.padEnd(9)} ${u.message}`),
  });

  // 6. Print the full result. `landed` tells you whether it worked.
  console.log('\n--- result ---');
  console.log(JSON.stringify(result, null, 2));
  if (!result.landed) console.error(`\nFailed: ${result.reason}\nWhat to do: ${result.suggestion}`);

  // 7. Release resources.
  await smart.disconnect();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
