import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { config } from './config';
import { loadStore, getNextRoundId, saveScore, hasScore, getScoresForRound } from './store';
import {
  createRound as solanaCreateRound,
  commitScore,
  makeCommitment,
  deriveSalt,
  tryFetchRound,
  fetchAllRounds,
  fetchScoreEntriesForRound,
} from './solana';
import { buildEnterRoundTx } from './wallet';

loadStore();

export const app = express();
app.use(cors());
app.use(express.json());

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const secret = req.headers['x-admin-secret'] || req.body?.adminSecret;
  if (secret !== config.ADMIN_SECRET) { res.status(401).json({ error: 'Unauthorized' }); return; }
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatChainRound(roundId: number, acc: any, now = Math.floor(Date.now() / 1000)) {
  const status = Object.keys(acc.status)[0];
  const endsAt = acc.endsAt.toNumber();
  return {
    roundId,
    status,
    entryFee: acc.entryFee.toNumber(),
    entryFeeSol: acc.entryFee.toNumber() / 1e9,
    totalPool: acc.totalPool.toNumber(),
    totalPoolSol: acc.totalPool.toNumber() / 1e9,
    playerCount: acc.playerCount,
    endsAt,
    timeRemainingSeconds: Math.max(0, endsAt - now),
    winner: acc.winner ? acc.winner.toBase58() : null,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/rounds — admin creates a new round on-chain.
 * Body: { entryFeeLamports: number, durationSeconds: number }
 */
app.post('/api/rounds', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { entryFeeLamports, durationSeconds } = req.body;
    if (!entryFeeLamports || entryFeeLamports <= 0)
      return res.status(400).json({ error: 'entryFeeLamports must be > 0' });
    if (!durationSeconds || durationSeconds <= 0)
      return res.status(400).json({ error: 'durationSeconds must be > 0' });

    const roundId = getNextRoundId();
    const txSig   = await solanaCreateRound(roundId, entryFeeLamports, durationSeconds);
    const now     = Math.floor(Date.now() / 1000);

    res.status(201).json({ roundId, entryFeeLamports, durationSeconds, endsAt: now + durationSeconds, txSignature: txSig });
  } catch (err: any) {
    console.error('[POST /api/rounds]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/rounds — list all open/closed rounds from chain.
 */
app.get('/api/rounds', async (_req: Request, res: Response) => {
  try {
    const all = await fetchAllRounds();
    const now = Math.floor(Date.now() / 1000);
    const active = all
      .map((r: any) => formatChainRound(r.account.roundId.toNumber(), r.account, now))
      .filter((r: any) => r.status === 'open' || r.status === 'closed')
      .sort((a: any, b: any) => b.roundId - a.roundId);
    res.json(active);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/rounds/:roundId/status — round info with countdown timer.
 */
app.get('/api/rounds/:roundId/status', async (req: Request, res: Response) => {
  try {
    const roundId = parseInt(req.params.roundId, 10);
    const acc = await tryFetchRound(roundId);
    if (!acc) return res.status(404).json({ error: 'Round not found' });
    res.json(formatChainRound(roundId, acc));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/rounds/:roundId/join — build unsigned enter_round tx for Phantom to sign.
 * Body: { wallet: string }
 */
app.post('/api/rounds/:roundId/join', async (req: Request, res: Response) => {
  try {
    const roundId = parseInt(req.params.roundId, 10);
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ error: 'wallet is required' });

    const acc = await tryFetchRound(roundId);
    if (!acc) return res.status(404).json({ error: 'Round not found' });

    const status = Object.keys(acc.status)[0];
    if (status !== 'open') return res.status(400).json({ error: 'Round is not open' });

    const now = Math.floor(Date.now() / 1000);
    if (now >= acc.endsAt.toNumber()) return res.status(400).json({ error: 'Round has expired' });

    const tx = await buildEnterRoundTx(roundId, wallet);
    res.json({ transaction: tx, roundId, entryFeeLamports: acc.entryFee.toNumber(), entryFeeSol: acc.entryFee.toNumber() / 1e9 });
  } catch (err: any) {
    console.error('[POST /join]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/rounds/:roundId/submit-score — commit score hash on-chain.
 * Body: { wallet: string, score: number }
 */
app.post('/api/rounds/:roundId/submit-score', async (req: Request, res: Response) => {
  try {
    const roundId = parseInt(req.params.roundId, 10);
    const { wallet, score } = req.body;

    if (!wallet) return res.status(400).json({ error: 'wallet is required' });
    if (score === undefined || score === null) return res.status(400).json({ error: 'score is required' });
    if (!Number.isInteger(score) || score < 0 || score > config.MAX_SCORE)
      return res.status(400).json({ error: `score must be an integer between 0 and ${config.MAX_SCORE}` });

    const acc = await tryFetchRound(roundId);
    if (!acc) return res.status(404).json({ error: 'Round not found' });

    const status = Object.keys(acc.status)[0];
    if (status !== 'open') return res.status(400).json({ error: 'Round is not open for score submission' });

    const now = Math.floor(Date.now() / 1000);
    if (now >= acc.endsAt.toNumber()) return res.status(400).json({ error: 'Round timer has expired' });

    if (hasScore(roundId, wallet)) return res.status(409).json({ error: 'Score already submitted for this round' });

    const salt       = deriveSalt(roundId, wallet);
    const commitment = makeCommitment(score, wallet, roundId, salt);
    const txSig      = await commitScore(roundId, wallet, commitment);

    saveScore(roundId, wallet, score);

    res.json({ success: true, txSignature: txSig });
  } catch (err: any) {
    console.error('[POST /submit-score]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/rounds/:roundId/leaderboard
 * During open/closed: hides scores. After finalised: full leaderboard from chain.
 */
app.get('/api/rounds/:roundId/leaderboard', async (req: Request, res: Response) => {
  try {
    const roundId = parseInt(req.params.roundId, 10);
    const acc = await tryFetchRound(roundId);
    if (!acc) return res.status(404).json({ error: 'Round not found' });

    const status = Object.keys(acc.status)[0];
    const scores = getScoresForRound(roundId);

    if (status === 'open' || status === 'closed') {
      res.json({
        roundId, status,
        playerCount: scores.length,
        leaderboard: null,
        hint: scores.length >= 3
          ? `3rd place exists. ${scores.length} players have submitted scores.`
          : `${scores.length} player(s) have submitted scores so far.`,
        scoresRevealed: false,
      });
      return;
    }

    // Finalised — read revealed scores from chain
    const entries  = await fetchScoreEntriesForRound(roundId);
    const winner   = acc.winner ? acc.winner.toBase58() : null;
    const leaderboard = entries
      .filter((e: any) => e.account.revealed)
      .map((e: any) => ({ wallet: e.account.player.toBase58(), score: e.account.revealedScore.toNumber(), isWinner: e.account.player.toBase58() === winner }))
      .sort((a: any, b: any) => b.score - a.score)
      .map((e: any, i: number) => ({ rank: i + 1, ...e }));

    res.json({ roundId, status, playerCount: leaderboard.length, winner, totalPoolSol: acc.totalPool.toNumber() / 1e9, leaderboard, scoresRevealed: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const { startWorker } = require('./worker');
  startWorker();
  app.listen(config.PORT, () => {
    console.log(`[Arcadia] Server running on port ${config.PORT}`);
    console.log(`[Arcadia] RPC: ${config.RPC_URL}`);
    console.log(`[Arcadia] Authority: ${require('./solana').backendKeypair.publicKey.toBase58()}`);
  });
}
