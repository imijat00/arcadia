import {
  fetchAllRounds,
  fetchScoreEntriesForRound,
  closeRound,
  revealScore,
  finaliseRound,
  tryFetchRound,
  deriveSalt,
} from './solana';
import { getScore, pruneRound } from './store';

const WORKER_INTERVAL_MS = 10_000;
const skippedRounds = new Set<number>();

async function tick(): Promise<void> {
  const all = await fetchAllRounds();
  const now = Math.floor(Date.now() / 1000);

  for (const { account } of all) {
    const roundId = account.roundId.toNumber();
    const status  = Object.keys(account.status)[0];
    const endsAt  = account.endsAt.toNumber();

    try {
      if (skippedRounds.has(roundId)) continue;
      if (status === 'open' && now >= endsAt) {
        await handleExpiredOpenRound(roundId);
      } else if (status === 'closed') {
        await handleClosedRound(roundId);
      }
    } catch (err: any) {
      console.error(`[Worker] Round ${roundId} error:`, err.message);
    }
  }
}

async function handleExpiredOpenRound(roundId: number): Promise<void> {
  console.log(`[Worker] Closing round ${roundId}...`);
  try {
    await closeRound(roundId);
  } catch (err: any) {
    const expected = err.message?.includes('RoundNotOpen') || err.message?.includes('was not confirmed');
    if (!expected) throw err;
    console.log(`[Worker] Round ${roundId} close uncertain — syncing from chain...`);
  }

  const onChain = await tryFetchRound(roundId);
  if (!onChain) return;
  const statusKey = Object.keys(onChain.status)[0];
  console.log(`[Worker] Round ${roundId} → ${statusKey} (${onChain.playerCount} players)`);
}

async function handleClosedRound(roundId: number): Promise<void> {
  const entries    = await fetchScoreEntriesForRound(roundId);
  const unrevealed = entries.filter((e: any) => !e.account.revealed);

  for (const entry of unrevealed) {
    const wallet = entry.account.player.toBase58();
    const score  = getScore(roundId, wallet);

    if (score === undefined) {
      console.log(`[Worker] No score stored for ${wallet} in round ${roundId} — skipping`);
      continue;
    }

    try {
      console.log(`[Worker] Revealing score for ${wallet} in round ${roundId}...`);
      const salt = deriveSalt(roundId, wallet);
      await revealScore(roundId, wallet, score, salt);
    } catch (err: any) {
      if (!err.message?.includes('AlreadyRevealed')) {
        console.error(`[Worker] Reveal failed for ${wallet}:`, err.message);
      }
    }
  }

  // Re-fetch to confirm all revealed
  const updated      = await fetchScoreEntriesForRound(roundId);
  const stillPending = updated.filter((e: any) => !e.account.revealed);
  if (stillPending.length > 0) return;
  if (updated.length === 0) return;

  const revealed = updated
    .filter((e: any) => e.account.revealed)
    .map((e: any) => ({ wallet: e.account.player.toBase58(), score: e.account.revealedScore.toNumber() }))
    .sort((a, b) => b.score - a.score);

  const winner = revealed[0];
  if (!winner) return;

  console.log(`[Worker] Finalising round ${roundId}, winner: ${winner.wallet} (score: ${winner.score})`);
  const allWallets = revealed.map(e => e.wallet);
  await finaliseRound(roundId, winner.wallet, allWallets);
  pruneRound(roundId);
  console.log(`[Worker] Round ${roundId} finalised. Winner: ${winner.wallet}`);
}

export function startWorker(): void {
  console.log('[Worker] Started — polling every 10s');
  tick();
  setInterval(() => tick().catch(err => console.error('[Worker] Tick error:', err.message)), WORKER_INTERVAL_MS);
}

if (require.main === module) {
  startWorker();
}
