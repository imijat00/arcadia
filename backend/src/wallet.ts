/**
 * wallet.ts — Transaction builder for the Unity client.
 *
 * The entry fee flow:
 *   1. Unity calls POST /api/rounds/:id/join with the player's wallet address
 *   2. Backend builds an unsigned enter_round transaction and returns it base64-encoded
 *   3. Unity deserializes the transaction, signs it with the player's Phantom wallet
 *   4. Unity sends the signed transaction directly to Solana
 *   5. Player's entry fee (SOL) goes wallet → round escrow PDA — backend never holds it
 *
 * The player's private key never leaves their device.
 */

import { PublicKey, Transaction } from '@solana/web3.js';
import { connection, buildEnterRoundInstruction } from './solana';

/**
 * Builds an unsigned enter_round transaction serialized as base64.
 * Unity deserializes this, signs with the player's wallet, and sends it to Solana.
 *
 * @param roundId  The round to join
 * @param wallet   Player's public key (base58)
 * @returns        Base64-encoded serialized transaction (unsigned)
 */
export async function buildEnterRoundTx(roundId: number, wallet: string): Promise<string> {
  const playerPubkey = new PublicKey(wallet);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const instruction = await buildEnterRoundInstruction(roundId, playerPubkey);

  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = playerPubkey;
  tx.add(instruction);

  // Serialize without requiring all signatures — player will sign on their device
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return serialized.toString('base64');
}

/**
 * Deserializes a base64 transaction returned by the backend,
 * signs it with the player's wallet, and returns it ready to send.
 *
 * This function is for reference — it runs in the Unity C# SDK, not the backend.
 * See unity-sdk/ArcadiaAPI.cs for the equivalent C# implementation.
 */
export function describeSigningFlow(): string {
  return [
    '1. Call POST /api/rounds/:id/join with { wallet: "yourBase58Address" }',
    '2. Response contains { transaction: "base64..." }',
    '3. Deserialize: Transaction.from(Buffer.from(tx, "base64"))',
    '4. Sign with player keypair: tx.sign(playerKeypair)',
    '5. Send: connection.sendRawTransaction(tx.serialize())',
  ].join('\n');
}
