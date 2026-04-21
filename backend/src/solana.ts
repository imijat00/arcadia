import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { BN } from 'bn.js';
import { createHash, createHmac } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

const IDL_PATH = path.resolve(__dirname, 'arcadia.json');
const idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf-8'));

const PROGRAM_ID = new PublicKey(config.PROGRAM_ID);

// ── Keypair & Provider ────────────────────────────────────────────────────────

function loadKeypair(): Keypair {
  // Render / cloud: set KEYPAIR_BASE64 = base64(cat ~/.config/solana/id.json)
  if (config.KEYPAIR_BASE64) {
    const secret = JSON.parse(Buffer.from(config.KEYPAIR_BASE64, 'base64').toString('utf-8'));
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  // Local: read from file path
  const expanded = config.WALLET_KEYPAIR_PATH.replace('~', process.env.HOME || '');
  const secret = JSON.parse(fs.readFileSync(expanded, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export const backendKeypair = loadKeypair();
export const connection = new Connection(config.RPC_URL, 'confirmed');

const wallet = new anchor.Wallet(backendKeypair);
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
export const program: any = new Program(idl, provider);

// ── PDA Derivation ────────────────────────────────────────────────────────────

export function deriveConfigPDA(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
  return pda;
}

export function deriveRoundPDA(roundId: number): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(roundId));
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('round'), buf], PROGRAM_ID);
  return pda;
}

export function deriveDailyPDA(player: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('daily'), player.toBuffer()],
    PROGRAM_ID,
  );
  return pda;
}

export function deriveScoreEntryPDA(roundId: number, player: PublicKey): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(roundId));
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('score'), buf, player.toBuffer()],
    PROGRAM_ID,
  );
  return pda;
}

// ── Commitment Helpers ────────────────────────────────────────────────────────

// Must match the Rust: sha256("score:walletBase58:roundId:salt")
export function makeCommitment(score: number, walletBase58: string, roundId: number, salt: string): number[] {
  const input = `${score}:${walletBase58}:${roundId}:${salt}`;
  const hash = createHash('sha256').update(input).digest();
  return Array.from(hash);
}

// Deterministic salt — derived from backend keypair + round + wallet. No DB needed.
export function deriveSalt(roundId: number, wallet: string): string {
  return createHmac('sha256', Buffer.from(backendKeypair.secretKey))
    .update(`${roundId}:${wallet}`)
    .digest('hex');
}

export async function fetchAllRounds(): Promise<any[]> {
  return program.account.round.all();
}

export async function fetchScoreEntriesForRound(roundId: number): Promise<any[]> {
  const all = await program.account.scoreEntry.all();
  return all.filter((e: any) => e.account.roundId.toNumber() === roundId);
}

// ── Account Fetchers ──────────────────────────────────────────────────────────

export async function fetchRound(roundId: number) {
  const pda = deriveRoundPDA(roundId);
  return program.account.round.fetch(pda);
}

export async function fetchScoreEntry(roundId: number, player: PublicKey) {
  const pda = deriveScoreEntryPDA(roundId, player);
  return program.account.scoreEntry.fetch(pda);
}

export async function fetchConfig() {
  const pda = deriveConfigPDA();
  return program.account.programConfig.fetch(pda);
}

export async function tryFetchRound(roundId: number): Promise<any | null> {
  try {
    return await fetchRound(roundId);
  } catch {
    return null;
  }
}

// ── Instruction Callers ───────────────────────────────────────────────────────

export async function createRound(roundId: number, entryFee: number, durationSeconds: number): Promise<string> {
  const roundPDA = deriveRoundPDA(roundId);
  const configPDA = deriveConfigPDA();

  return program.methods
    .createRound(new BN(roundId), new BN(entryFee), new BN(durationSeconds))
    .accounts({
      round: roundPDA,
      config: configPDA,
      authority: backendKeypair.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

export async function closeRound(roundId: number): Promise<string> {
  const roundPDA = deriveRoundPDA(roundId);

  return program.methods
    .closeRound(new BN(roundId))
    .accounts({
      round: roundPDA,
      authority: backendKeypair.publicKey,
    })
    .rpc();
}

export async function commitScore(roundId: number, playerWallet: string, commitment: number[]): Promise<string> {
  const roundPDA = deriveRoundPDA(roundId);
  const playerPubkey = new PublicKey(playerWallet);
  const scoreEntryPDA = deriveScoreEntryPDA(roundId, playerPubkey);

  return program.methods
    .commitScore(new BN(roundId), commitment)
    .accounts({
      round: roundPDA,
      scoreEntry: scoreEntryPDA,
      player: playerPubkey,
      authority: backendKeypair.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

export async function revealScore(roundId: number, playerWallet: string, score: number, salt: string): Promise<string> {
  const roundPDA = deriveRoundPDA(roundId);
  const playerPubkey = new PublicKey(playerWallet);
  const scoreEntryPDA = deriveScoreEntryPDA(roundId, playerPubkey);

  return program.methods
    .revealScore(new BN(roundId), new BN(score), salt)
    .accounts({
      round: roundPDA,
      scoreEntry: scoreEntryPDA,
      authority: backendKeypair.publicKey,
    })
    .rpc();
}

export async function finaliseRound(roundId: number, winner: string, allPlayerWallets: string[]): Promise<string> {
  const roundPDA = deriveRoundPDA(roundId);
  const configPDA = deriveConfigPDA();
  const winnerPubkey = new PublicKey(winner);
  const cfg = await fetchConfig();

  const remainingAccounts = allPlayerWallets.map(w => {
    const scorePDA = deriveScoreEntryPDA(roundId, new PublicKey(w));
    return { pubkey: scorePDA, isWritable: false, isSigner: false };
  });

  return program.methods
    .finaliseRound(new BN(roundId), winnerPubkey)
    .accounts({
      round: roundPDA,
      config: configPDA,
      winnerAccount: winnerPubkey,
      treasury: (cfg as any).treasury,
      authority: backendKeypair.publicKey,
    })
    .remainingAccounts(remainingAccounts)
    .rpc();
}

export async function refundPlayer(roundId: number, playerWallet: string): Promise<string> {
  const roundPDA = deriveRoundPDA(roundId);
  const playerPubkey = new PublicKey(playerWallet);
  const scoreEntryPDA = deriveScoreEntryPDA(roundId, playerPubkey);

  return program.methods
    .refundPlayer(new BN(roundId))
    .accounts({
      round: roundPDA,
      player: playerPubkey,
      scoreEntry: scoreEntryPDA,
      caller: backendKeypair.publicKey,
    })
    .rpc();
}

// ── Transaction Builder (for Unity — player signs) ───────────────────────────

export async function buildEnterRoundInstruction(roundId: number, playerPubkey: PublicKey) {
  const roundPDA = deriveRoundPDA(roundId);
  const dailyPDA = deriveDailyPDA(playerPubkey);

  return program.methods
    .enterRound(new BN(roundId))
    .accounts({
      round: roundPDA,
      dailyRecord: dailyPDA,
      player: playerPubkey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}
