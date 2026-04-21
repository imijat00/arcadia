/**
 * client/arcadia.ts — Arcadia TypeScript client library.
 *
 * Standalone SDK for interacting with the Arcadia Solana program.
 * Use this in Node.js scripts, backend integrations, or testing.
 *
 * Program ID: 5ska6kVyEfGjQ7MxfYPoxeBK75JDAzz6q5aYdN26RgbS
 * Anchor: 0.31.1  |  IDL: target/idl/arcadia.json
 */

import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { BN } from 'bn.js';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ── Constants ─────────────────────────────────────────────────────────────────

export const PROGRAM_ID = new PublicKey('5ska6kVyEfGjQ7MxfYPoxeBK75JDAzz6q5aYdN26RgbS');

const IDL_PATH = path.resolve(__dirname, '../target/idl/arcadia.json');

// ── PDA Derivation ─────────────────────────────────────────────────────────────

export function deriveConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
}

export function deriveRoundPDA(roundId: number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(roundId));
  return PublicKey.findProgramAddressSync([Buffer.from('round'), buf], PROGRAM_ID);
}

export function deriveDailyPDA(player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('daily'), player.toBuffer()],
    PROGRAM_ID,
  );
}

export function deriveScoreEntryPDA(roundId: number, player: PublicKey): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(roundId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from('score'), buf, player.toBuffer()],
    PROGRAM_ID,
  );
}

// ── Commitment ─────────────────────────────────────────────────────────────────

/**
 * Computes the SHA-256 commitment hash exactly as the Rust contract does.
 * Input format: "${score}:${walletBase58}:${roundId}:${salt}"
 */
export function makeCommitment(score: number, walletBase58: string, roundId: number, salt: string): number[] {
  const input = `${score}:${walletBase58}:${roundId}:${salt}`;
  const hash = createHash('sha256').update(input).digest();
  return Array.from(hash);
}

export function generateSalt(): string {
  return randomBytes(32).toString('hex');
}

// ── Client class ───────────────────────────────────────────────────────────────

export class ArcadiaClient {
  readonly program: Program;
  readonly provider: AnchorProvider;
  readonly connection: Connection;
  readonly authority: Keypair;

  constructor(connection: Connection, keypair: Keypair) {
    this.connection = connection;
    this.authority = keypair;

    const idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf-8'));
    const wallet = new anchor.Wallet(keypair);
    this.provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    this.program = new Program(idl, this.provider);
  }

  static fromKeypairPath(rpcUrl: string, keypairPath: string): ArcadiaClient {
    const expanded = keypairPath.replace('~', process.env.HOME || '');
    const secret = JSON.parse(fs.readFileSync(expanded, 'utf-8'));
    const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
    const connection = new Connection(rpcUrl, 'confirmed');
    return new ArcadiaClient(connection, keypair);
  }

  // ── Account Fetchers ──────────────────────────────────────────────────────

  async fetchConfig() {
    const [pda] = deriveConfigPDA();
    return this.program.account.programConfig.fetch(pda);
  }

  async fetchRound(roundId: number) {
    const [pda] = deriveRoundPDA(roundId);
    return this.program.account.round.fetch(pda);
  }

  async fetchScoreEntry(roundId: number, player: PublicKey) {
    const [pda] = deriveScoreEntryPDA(roundId, player);
    return this.program.account.scoreEntry.fetch(pda);
  }

  async tryFetchRound(roundId: number): Promise<any | null> {
    try { return await this.fetchRound(roundId); } catch { return null; }
  }

  async tryFetchScoreEntry(roundId: number, player: PublicKey): Promise<any | null> {
    try { return await this.fetchScoreEntry(roundId, player); } catch { return null; }
  }

  // ── Instructions (backend-signed) ─────────────────────────────────────────

  async initializeConfig(treasury: PublicKey, feeBps: number): Promise<string> {
    const [configPDA] = deriveConfigPDA();
    return this.program.methods
      .initializeConfig(treasury, new BN(feeBps))
      .accounts({
        config: configPDA,
        authority: this.authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async createRound(roundId: number, entryFee: number, durationSeconds: number): Promise<string> {
    const [roundPDA] = deriveRoundPDA(roundId);
    const [configPDA] = deriveConfigPDA();
    return this.program.methods
      .createRound(new BN(roundId), new BN(entryFee), new BN(durationSeconds))
      .accounts({
        round: roundPDA,
        config: configPDA,
        authority: this.authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async commitScore(roundId: number, playerWallet: string, commitment: number[]): Promise<string> {
    const playerPubkey = new PublicKey(playerWallet);
    const [roundPDA] = deriveRoundPDA(roundId);
    const [scoreEntryPDA] = deriveScoreEntryPDA(roundId, playerPubkey);
    return this.program.methods
      .commitScore(new BN(roundId), commitment)
      .accounts({
        round: roundPDA,
        scoreEntry: scoreEntryPDA,
        player: playerPubkey,
        authority: this.authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async closeRound(roundId: number): Promise<string> {
    const [roundPDA] = deriveRoundPDA(roundId);
    return this.program.methods
      .closeRound(new BN(roundId))
      .accounts({
        round: roundPDA,
        authority: this.authority.publicKey,
      })
      .rpc();
  }

  async revealScore(roundId: number, playerWallet: string, score: number, salt: string): Promise<string> {
    const playerPubkey = new PublicKey(playerWallet);
    const [roundPDA] = deriveRoundPDA(roundId);
    const [scoreEntryPDA] = deriveScoreEntryPDA(roundId, playerPubkey);
    return this.program.methods
      .revealScore(new BN(roundId), new BN(score), salt)
      .accounts({
        round: roundPDA,
        scoreEntry: scoreEntryPDA,
        authority: this.authority.publicKey,
      })
      .rpc();
  }

  async finaliseRound(roundId: number, winner: string, allPlayerWallets: string[]): Promise<string> {
    const winnerPubkey = new PublicKey(winner);
    const [roundPDA] = deriveRoundPDA(roundId);
    const [configPDA] = deriveConfigPDA();
    const cfg = await this.fetchConfig();

    const remainingAccounts = allPlayerWallets.map(w => {
      const [scorePDA] = deriveScoreEntryPDA(roundId, new PublicKey(w));
      return { pubkey: scorePDA, isWritable: false, isSigner: false };
    });

    return this.program.methods
      .finaliseRound(new BN(roundId), winnerPubkey)
      .accounts({
        round: roundPDA,
        config: configPDA,
        winnerAccount: winnerPubkey,
        treasury: (cfg as any).treasury,
        authority: this.authority.publicKey,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();
  }

  async refundPlayer(roundId: number, playerWallet: string): Promise<string> {
    const playerPubkey = new PublicKey(playerWallet);
    const [roundPDA] = deriveRoundPDA(roundId);
    const [scoreEntryPDA] = deriveScoreEntryPDA(roundId, playerPubkey);
    return this.program.methods
      .refundPlayer(new BN(roundId))
      .accounts({
        round: roundPDA,
        player: playerPubkey,
        scoreEntry: scoreEntryPDA,
        caller: this.authority.publicKey,
      })
      .rpc();
  }

  // ── Unsigned transaction builder (player-signed enter_round) ──────────────

  async buildEnterRoundTx(roundId: number, playerPubkey: PublicKey): Promise<string> {
    const [roundPDA] = deriveRoundPDA(roundId);
    const [dailyPDA] = deriveDailyPDA(playerPubkey);
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

    const ix = await this.program.methods
      .enterRound(new BN(roundId))
      .accounts({
        round: roundPDA,
        dailyRecord: dailyPDA,
        player: playerPubkey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = playerPubkey;
    tx.add(ix);

    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  /**
   * Formats a fetched Round account into a human-readable object.
   * BN fields are converted to numbers (safe for MVP amounts).
   */
  formatRound(round: any) {
    const statusKey = Object.keys(round.status)[0];
    return {
      roundId: round.roundId.toNumber(),
      status: statusKey,
      entryFee: round.entryFee.toNumber(),
      entryFeeSol: round.entryFee.toNumber() / LAMPORTS_PER_SOL,
      totalPool: round.totalPool.toNumber(),
      totalPoolSol: round.totalPool.toNumber() / LAMPORTS_PER_SOL,
      playerCount: round.playerCount.toNumber(),
      endsAt: round.endsAt.toNumber(),
      revealDeadline: round.revealDeadline.toNumber(),
      winner: round.winner.toBase58() === '11111111111111111111111111111111'
        ? null
        : round.winner.toBase58(),
    };
  }
}

// ── Default export ────────────────────────────────────────────────────────────

export default ArcadiaClient;
