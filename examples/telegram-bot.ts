/**
 * telegram-bot.ts - a stablecoin payment request bot pattern.
 *
 * This is a credible, runnable demonstration of how to wire solana-smart-tx
 * into a Telegram bot. It is intentionally small: three commands that show the
 * integration pattern most Nigerian builders reach for first.
 *
 * Commands:
 *   /send [amount] [recipient]  Send USDC and stream progress back to the chat.
 *   /status [signature]         Look up the commitment level of a signature.
 *   /balance                    Show the bot wallet's SOL and USDC balance.
 *
 * To run this you need (all via .env, see .env.example):
 *   - TELEGRAM_BOT_TOKEN   from @BotFather on Telegram
 *   - RPC_URL              a Helius (or any) Solana RPC URL
 *   - WALLET_PRIVATE_KEY   base58 secret key for the bot's wallet
 *   - USDC_MINT            the USDC mint (mainnet default is in .env.example)
 *
 *   npm run example:telegram
 */

import 'dotenv/config';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js';
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { Telegraf } from 'telegraf';
import { SmartTx } from '../src';

// --- config ----------------------------------------------------------------
const BOT_TOKEN = requireEnv('TELEGRAM_BOT_TOKEN');
const RPC_URL = requireEnv('RPC_URL');
const WALLET_PRIVATE_KEY = requireEnv('WALLET_PRIVATE_KEY');
const USDC_MINT = new PublicKey(process.env.USDC_MINT ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;

const wallet = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
const connection = new Connection(RPC_URL, 'confirmed');
const smart = new SmartTx({ rpcUrl: RPC_URL, wallet, network: 'mainnet-beta' });
const bot = new Telegraf(BOT_TOKEN);

/** Reads a required environment variable or exits with a clear message. */
function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key} in .env (see .env.example).`);
  return value;
}

// --- /send [amount] [recipient] --------------------------------------------
bot.command('send', async (ctx) => {
  const [, amountRaw, recipientRaw] = ctx.message.text.split(/\s+/);
  const amount = Number(amountRaw);
  if (!amountRaw || !recipientRaw || Number.isNaN(amount) || amount <= 0) {
    await ctx.reply('Usage: /send [amount] [recipient_address]');
    return;
  }

  let recipient: PublicKey;
  try {
    recipient = new PublicKey(recipientRaw);
  } catch {
    await ctx.reply('That recipient address is not a valid Solana public key.');
    return;
  }

  try {
    // Resolve token accounts, creating the sender's ATA if it does not exist.
    const fromAta = await getOrCreateAssociatedTokenAccount(connection, wallet, USDC_MINT, wallet.publicKey);
    const toAta = await getAssociatedTokenAddress(USDC_MINT, recipient);

    // Build the SPL token transfer (amount scaled to USDC's 6 decimals).
    const transaction = new Transaction().add(
      createTransferInstruction(
        fromAta.address,
        toAta,
        wallet.publicKey,
        BigInt(Math.round(amount * 10 ** USDC_DECIMALS)),
      ),
    );

    await ctx.reply(`Sending ${amount} USDC to ${recipientRaw.slice(0, 8)}...`);

    // Hand off to SmartTx and stream each lifecycle stage back to the chat.
    const result = await smart.send({
      transaction,
      onStatus: (u) => {
        void ctx.reply(`[${u.stage}] ${u.message}`);
      },
    });

    if (result.landed) {
      await ctx.reply(`Done. ${amount} USDC sent.\nSignature: ${result.signature}`);
    } else {
      await ctx.reply(`Payment failed: ${result.reason}\nWhat to do: ${result.suggestion}`);
    }
  } catch (err) {
    // Diagnose unexpected errors with the same classifier the send loop uses.
    const classified = smart.classifyError(err instanceof Error ? err.message : String(err));
    await ctx.reply(`Could not send: ${classified.reasoning}\nWhat to do: ${classified.suggestion}`);
  }
});

// --- /status [signature] ---------------------------------------------------
bot.command('status', async (ctx) => {
  const [, signature] = ctx.message.text.split(/\s+/);
  if (!signature) {
    await ctx.reply('Usage: /status [signature]');
    return;
  }

  const { value } = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
  if (!value) {
    await ctx.reply('That signature has not been seen on-chain yet.');
    return;
  }
  if (value.err) {
    await ctx.reply(`Transaction failed on-chain at slot ${value.slot}.`);
    return;
  }
  await ctx.reply(`Status: ${value.confirmationStatus ?? 'processed'} at slot ${value.slot}.`);
});

// --- /balance --------------------------------------------------------------
bot.command('balance', async (ctx) => {
  const solLamports = await connection.getBalance(wallet.publicKey);
  const sol = (solLamports / LAMPORTS_PER_SOL).toFixed(4);

  let usdc = '0';
  try {
    const ata = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
    const balance = await connection.getTokenAccountBalance(ata);
    usdc = balance.value.uiAmountString ?? '0';
  } catch {
    // No USDC token account yet; treat the balance as zero.
  }

  await ctx.reply(`Wallet ${wallet.publicKey.toBase58()}\nSOL: ${sol}\nUSDC: ${usdc}`);
});

// --- launch ----------------------------------------------------------------
bot.launch().then(() => console.log('Bot is running. Send /balance in your chat to test.'));

// Graceful shutdown: stop the bot and close SmartTx resources.
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  void smart.disconnect();
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  void smart.disconnect();
});
