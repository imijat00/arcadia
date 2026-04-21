import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const config = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  RPC_URL: process.env.RPC_URL || 'http://127.0.0.1:8899',
  // Render: set KEYPAIR_BASE64 to the base64-encoded contents of id.json
  // Local:  set WALLET_KEYPAIR_PATH (defaults to ~/.config/solana/id.json)
  KEYPAIR_BASE64: process.env.KEYPAIR_BASE64 || '',
  WALLET_KEYPAIR_PATH: process.env.WALLET_KEYPAIR_PATH ||
    `${process.env.HOME}/.config/solana/id.json`,
  PROGRAM_ID: '5ska6kVyEfGjQ7MxfYPoxeBK75JDAzz6q5aYdN26RgbS',
  ADMIN_SECRET: process.env.ADMIN_SECRET || 'dev-secret-change-in-production',
  MAX_SCORE: parseInt(process.env.MAX_SCORE || '1000000', 10),
};
