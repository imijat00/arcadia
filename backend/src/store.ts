import * as fs from 'fs';
import * as path from 'path';

const STORE_PATH = path.resolve(process.cwd(), 'scores.json');

interface Store {
  nextRoundId: number;
  scores: Record<string, number>; // key: `${roundId}:${wallet}`, value: score
}

let _data: Store = { nextRoundId: 1, scores: {} };

export function loadStore(): void {
  if (fs.existsSync(STORE_PATH)) {
    try { _data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8')); } catch {}
  }
}

function save(): void {
  fs.writeFileSync(STORE_PATH, JSON.stringify(_data, null, 2));
}

export function getNextRoundId(): number {
  const id = _data.nextRoundId;
  _data.nextRoundId++;
  save();
  return id;
}

export function saveScore(roundId: number, wallet: string, score: number): void {
  _data.scores[`${roundId}:${wallet}`] = score;
  save();
}

export function getScore(roundId: number, wallet: string): number | undefined {
  return _data.scores[`${roundId}:${wallet}`];
}

export function hasScore(roundId: number, wallet: string): boolean {
  return `${roundId}:${wallet}` in _data.scores;
}

export function getScoresForRound(roundId: number): { wallet: string; score: number }[] {
  return Object.entries(_data.scores)
    .filter(([k]) => k.startsWith(`${roundId}:`))
    .map(([k, score]) => ({ wallet: k.split(':')[1], score }));
}

export function pruneRound(roundId: number): void {
  for (const k of Object.keys(_data.scores)) {
    if (k.startsWith(`${roundId}:`)) delete _data.scores[k];
  }
  save();
}
