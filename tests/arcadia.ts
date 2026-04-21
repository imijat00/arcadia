// @ts-nocheck
/**
 * Arcadia — Full Anchor Test Suite
 * Uses generated IDL from target/idl/arcadia.json
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";
import { expect } from "chai";
import { BN } from "bn.js";

const idl = require("../target/idl/arcadia.json");

// ============================================================================
// Helpers
// ============================================================================

const PROGRAM_ID = new PublicKey("5ska6kVyEfGjQ7MxfYPoxeBK75JDAzz6q5aYdN26RgbS");

function deriveConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
}

function deriveRoundPDA(roundId: number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(roundId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("round"), buf],
    PROGRAM_ID
  );
}

function deriveDailyPDA(player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily"), player.toBuffer()],
    PROGRAM_ID
  );
}

function deriveScoreEntryPDA(
  roundId: number,
  player: PublicKey
): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(roundId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("score"), buf, player.toBuffer()],
    PROGRAM_ID
  );
}

function makeCommitment(
  score: number,
  wallet: string,
  roundId: number,
  salt: string
): number[] {
  const input = `${score}:${wallet}:${roundId}:${salt}`;
  const hash = createHash("sha256").update(input).digest();
  return Array.from(hash);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Tests
// ============================================================================

describe("arcadia", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  console.log("IDL loaded:", !!idl);
  console.log("IDL address:", idl?.address);
  console.log("Expected program ID:", PROGRAM_ID.toBase58());

  const program = new Program(idl as any, provider);

  const authority = provider.wallet as anchor.Wallet;
  const treasury = Keypair.generate();
  const player1 = Keypair.generate();
  const player2 = Keypair.generate();
  const player3 = Keypair.generate();

  const ENTRY_FEE = 0.1 * LAMPORTS_PER_SOL;
  const ROUND_DURATION = 3;
  const FEE_BPS = 500;

  const salts: Record<string, string> = {};
  const scores: Record<string, number> = {};

  before(async () => {
    console.log("Program ID from program object:", program.programId.toBase58());
    console.log("Authority:", authority.publicKey.toBase58());

    expect(program.programId.toBase58()).to.equal(PROGRAM_ID.toBase58());

    for (const kp of [player1, player2, player3, treasury]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }
    console.log("Airdrops complete");
  });

  // --------------------------------------------------------------------------
  // 1. Initialize Config
  // --------------------------------------------------------------------------
  it("initializes program config", async () => {
    const [configPDA] = deriveConfigPDA();

    await program.methods
      .initializeConfig(treasury.publicKey, new BN(FEE_BPS))
      .accounts({
        config: configPDA,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.programConfig.fetch(configPDA);
    expect(config.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
    expect(config.feeBps.toNumber()).to.equal(FEE_BPS);
  });

  // --------------------------------------------------------------------------
  // 2. Happy Path
  // --------------------------------------------------------------------------
  describe("Happy path — full round lifecycle", () => {
    const roundId = 1;

    it("creates a round", async () => {
      const [roundPDA] = deriveRoundPDA(roundId);
      const [configPDA] = deriveConfigPDA();

      await program.methods
        .createRound(new BN(roundId), new BN(ENTRY_FEE), new BN(ROUND_DURATION))
        .accounts({
          round: roundPDA,
          config: configPDA,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const round = await program.account.round.fetch(roundPDA);
      expect(round.roundId.toNumber()).to.equal(roundId);
      expect(round.entryFee.toNumber()).to.equal(ENTRY_FEE);
      expect(round.playerCount.toNumber()).to.equal(0);
    });

    it("3 players enter the round", async () => {
      const [roundPDA] = deriveRoundPDA(roundId);

      for (const player of [player1, player2, player3]) {
        const [dailyPDA] = deriveDailyPDA(player.publicKey);

        await program.methods
          .enterRound(new BN(roundId))
          .accounts({
            round: roundPDA,
            dailyRecord: dailyPDA,
            player: player.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([player])
          .rpc();
      }

      const round = await program.account.round.fetch(roundPDA);
      expect(round.playerCount.toNumber()).to.equal(3);
      expect(round.totalPool.toNumber()).to.equal(ENTRY_FEE * 3);
    });

    it("commits scores for all 3 players", async () => {
      const [roundPDA] = deriveRoundPDA(roundId);

      const playerScores = [
        { kp: player1, score: 150 },
        { kp: player2, score: 420 },
        { kp: player3, score: 310 },
      ];

      for (const { kp, score } of playerScores) {
        const salt = randomBytes(32).toString("hex");
        const commitment = makeCommitment(
          score,
          kp.publicKey.toBase58(),
          roundId,
          salt
        );

        salts[kp.publicKey.toBase58()] = salt;
        scores[kp.publicKey.toBase58()] = score;

        const [scoreEntryPDA] = deriveScoreEntryPDA(roundId, kp.publicKey);

        await program.methods
          .commitScore(new BN(roundId), commitment)
          .accounts({
            round: roundPDA,
            scoreEntry: scoreEntryPDA,
            player: kp.publicKey,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }
    });

    it("closes the round after timer expires", async () => {
      await sleep((ROUND_DURATION + 2) * 1000);

      const [roundPDA] = deriveRoundPDA(roundId);

      await program.methods
        .closeRound(new BN(roundId))
        .accounts({
          round: roundPDA,
          authority: authority.publicKey,
        })
        .rpc();

      const round = await program.account.round.fetch(roundPDA);
      expect(JSON.stringify(round.status).toLowerCase()).to.include("closed");
    });

    it("reveals all scores", async () => {
      const [roundPDA] = deriveRoundPDA(roundId);

      for (const player of [player1, player2, player3]) {
        const pubkey = player.publicKey.toBase58();
        const [scoreEntryPDA] = deriveScoreEntryPDA(roundId, player.publicKey);

        await program.methods
          .revealScore(new BN(roundId), new BN(scores[pubkey]), salts[pubkey])
          .accounts({
            round: roundPDA,
            scoreEntry: scoreEntryPDA,
            authority: authority.publicKey,
          })
          .rpc();

        const entry = await program.account.scoreEntry.fetch(scoreEntryPDA);
        expect(entry.revealed).to.be.true;
        expect(entry.revealedScore.toNumber()).to.equal(scores[pubkey]);
      }
    });

    it("finalises round — winner gets 95%, treasury gets 5%", async () => {
      const [roundPDA] = deriveRoundPDA(roundId);
      const [configPDA] = deriveConfigPDA();

      const totalPool = ENTRY_FEE * 3;
      const expectedTreasury = Math.floor((totalPool * FEE_BPS) / 10_000);
      const expectedWinner = totalPool - expectedTreasury;

      const winnerBalBefore = await provider.connection.getBalance(
        player2.publicKey
      );
      const treasuryBalBefore = await provider.connection.getBalance(
        treasury.publicKey
      );

      const remainingAccounts = [player1, player2, player3].map((p) => {
        const [scorePDA] = deriveScoreEntryPDA(roundId, p.publicKey);
        return { pubkey: scorePDA, isWritable: false, isSigner: false };
      });

      await program.methods
        .finaliseRound(new BN(roundId), player2.publicKey)
        .accounts({
          round: roundPDA,
          config: configPDA,
          winnerAccount: player2.publicKey,
          treasury: treasury.publicKey,
          authority: authority.publicKey,
        })
        .remainingAccounts(remainingAccounts)
        .rpc();

      const round = await program.account.round.fetch(roundPDA);
      expect(round.winner.toBase58()).to.equal(player2.publicKey.toBase58());

      const winnerBalAfter = await provider.connection.getBalance(
        player2.publicKey
      );
      const treasuryBalAfter = await provider.connection.getBalance(
        treasury.publicKey
      );

      expect(winnerBalAfter - winnerBalBefore).to.equal(expectedWinner);
      expect(treasuryBalAfter - treasuryBalBefore).to.equal(expectedTreasury);

      console.log(
        `Payout: winner=${expectedWinner / LAMPORTS_PER_SOL} SOL, treasury=${
          expectedTreasury / LAMPORTS_PER_SOL
        } SOL`
      );
    });
  });

  // --------------------------------------------------------------------------
  // 3. Refund — not enough players
  // --------------------------------------------------------------------------
  describe("Refund — not enough players", () => {
    const roundId = 100;

    it("cancels round with 1 player and refunds", async () => {
      const [roundPDA] = deriveRoundPDA(roundId);
      const [configPDA] = deriveConfigPDA();

      await program.methods
        .createRound(new BN(roundId), new BN(ENTRY_FEE), new BN(2))
        .accounts({
          round: roundPDA,
          config: configPDA,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const [dailyPDA] = deriveDailyPDA(player1.publicKey);
      await program.methods
        .enterRound(new BN(roundId))
        .accounts({
          round: roundPDA,
          dailyRecord: dailyPDA,
          player: player1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([player1])
        .rpc();

      const salt = randomBytes(32).toString("hex");
      const commitment = makeCommitment(
        100,
        player1.publicKey.toBase58(),
        roundId,
        salt
      );
      const [scoreEntryPDA] = deriveScoreEntryPDA(roundId, player1.publicKey);

      await program.methods
        .commitScore(new BN(roundId), commitment)
        .accounts({
          round: roundPDA,
          scoreEntry: scoreEntryPDA,
          player: player1.publicKey,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await sleep(3000);

      await program.methods
        .closeRound(new BN(roundId))
        .accounts({
          round: roundPDA,
          authority: authority.publicKey,
        })
        .rpc();

      const round = await program.account.round.fetch(roundPDA);
      expect(JSON.stringify(round.status).toLowerCase()).to.include("cancelled");

      const balBefore = await provider.connection.getBalance(player1.publicKey);

      await program.methods
        .refundPlayer(new BN(roundId))
        .accounts({
          round: roundPDA,
          player: player1.publicKey,
          scoreEntry: scoreEntryPDA,
          caller: player1.publicKey,
        })
        .signers([player1])
        .rpc();

      const balAfter = await provider.connection.getBalance(player1.publicKey);
      expect(balAfter).to.be.greaterThan(balBefore);

      console.log(`Refund: ${(balAfter - balBefore) / LAMPORTS_PER_SOL} SOL`);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Invalid reveal — wrong salt
  // --------------------------------------------------------------------------
  describe("Invalid reveal — wrong salt", () => {
    const roundId = 200;

    it("rejects reveal with wrong salt", async () => {
      const [roundPDA] = deriveRoundPDA(roundId);
      const [configPDA] = deriveConfigPDA();

      await program.methods
        .createRound(new BN(roundId), new BN(ENTRY_FEE), new BN(2))
        .accounts({
          round: roundPDA,
          config: configPDA,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      for (const p of [player1, player2]) {
        const [dailyPDA] = deriveDailyPDA(p.publicKey);
        await program.methods
          .enterRound(new BN(roundId))
          .accounts({
            round: roundPDA,
            dailyRecord: dailyPDA,
            player: p.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([p])
          .rpc();
      }

      const realSalt = randomBytes(32).toString("hex");
      const commitment = makeCommitment(
        100,
        player1.publicKey.toBase58(),
        roundId,
        realSalt
      );
      const [scoreEntryPDA] = deriveScoreEntryPDA(roundId, player1.publicKey);

      await program.methods
        .commitScore(new BN(roundId), commitment)
        .accounts({
          round: roundPDA,
          scoreEntry: scoreEntryPDA,
          player: player1.publicKey,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await sleep(3000);

      await program.methods
        .closeRound(new BN(roundId))
        .accounts({
          round: roundPDA,
          authority: authority.publicKey,
        })
        .rpc();

      try {
        await program.methods
          .revealScore(new BN(roundId), new BN(100), "wrong_salt_here")
          .accounts({
            round: roundPDA,
            scoreEntry: scoreEntryPDA,
            authority: authority.publicKey,
          })
          .rpc();

        expect.fail("Should have thrown InvalidReveal");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidReveal");
        console.log("✓ Invalid reveal correctly rejected");
      }
    });
  });

  // --------------------------------------------------------------------------
  // 5. Daily limit — max 5 entries
  // --------------------------------------------------------------------------
  describe("Daily limit — max 5 entries", () => {
    it("rejects 6th entry in same day", async () => {
      const baseId = 300;

      for (let i = 0; i < 6; i++) {
        const rid = baseId + i;
        const [roundPDA] = deriveRoundPDA(rid);
        const [configPDA] = deriveConfigPDA();

        await program.methods
          .createRound(new BN(rid), new BN(ENTRY_FEE), new BN(600))
          .accounts({
            round: roundPDA,
            config: configPDA,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }

      const freshPlayer = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        freshPlayer.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      for (let i = 0; i < 5; i++) {
        const rid = baseId + i;
        const [roundPDA] = deriveRoundPDA(rid);
        const [dailyPDA] = deriveDailyPDA(freshPlayer.publicKey);

        await program.methods
          .enterRound(new BN(rid))
          .accounts({
            round: roundPDA,
            dailyRecord: dailyPDA,
            player: freshPlayer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([freshPlayer])
          .rpc();
      }

      const rid6 = baseId + 5;
      const [roundPDA6] = deriveRoundPDA(rid6);
      const [dailyPDA6] = deriveDailyPDA(freshPlayer.publicKey);

      try {
        await program.methods
          .enterRound(new BN(rid6))
          .accounts({
            round: roundPDA6,
            dailyRecord: dailyPDA6,
            player: freshPlayer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([freshPlayer])
          .rpc();

        expect.fail("Should have thrown DailyLimitReached");
      } catch (err: any) {
        expect(err.toString()).to.include("DailyLimitReached");
        console.log("✓ 6th entry correctly rejected");
      }
    });
  });
  // --------------------------------------------------------------------------
  // 6. Read all on-chain data
  // --------------------------------------------------------------------------
  describe("Read on-chain state", () => {
    it("prints all accounts in human-readable format", async () => {
      const accounts = await provider.connection.getProgramAccounts(PROGRAM_ID);
      console.log("\n    === ON-CHAIN STATE ===");
      console.log("    Total accounts:", accounts.length, "\n");

      for (const acc of accounts) {
        const data = acc.account.data;
        const size = data.length;
        const sol = acc.account.lamports / 1e9;

        if (size === 98) {
          const player = new PublicKey(data.slice(8, 40));
          const roundId = Number(data.readBigUInt64LE(40));
          const revealed = data[88] === 1;
          const score = Number(data.readBigUInt64LE(89));
          console.log("    [ScoreEntry] Round:", roundId,
            "| Player:", player.toBase58().slice(0,8) + "...",
            "| Revealed:", revealed,
            "| Score:", revealed ? score : "(hidden)");
        }

        if (size > 100 && size < 200) {
          const roundId = Number(data.readBigUInt64LE(8));
          const entryFee = Number(data.readBigUInt64LE(48)) / 1e9;
          const totalPool = Number(data.readBigUInt64LE(56)) / 1e9;
          const playerCount = Number(data.readBigUInt64LE(64));
          const statusByte = data[72];
          const statuses = ["Open","Closed","Finalised","Cancelled","Refundable"];
          console.log("    [Round] ID:", roundId,
            "| Fee:", entryFee, "SOL",
            "| Pool:", totalPool, "SOL",
            "| Players:", playerCount,
            "| Status:", statuses[statusByte]);
        }
      }
      console.log("\n    === END ===\n");
    });
  });
});