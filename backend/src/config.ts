import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function required(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  RPC_URL: process.env.RPC_URL || 'http://127.0.0.1:8899',
  WALLET_KEYPAIR_PATH: process.env.WALLET_KEYPAIR_PATH ||
    `${process.env.HOME}/.config/solana/id.json`,
  PROGRAM_ID: '5ska6kVyEfGjQ7MxfYPoxeBK75JDAzz6q5aYdN26RgbS',
  ADMIN_SECRET: process.env.ADMIN_SECRET || 'dev-secret-change-in-production',
  MAX_SCORE: parseInt(process.env.MAX_SCORE || '1000000', 10),
};
