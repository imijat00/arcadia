import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

const RPC_URL    = process.env.RPC_URL    || 'https://api.devnet.solana.com';
const KEYPAIR    = process.env.KEYPAIR    || `${process.env.HOME}/.config/solana/id.json`;
// Treasury receives the 5% platform fee — defaults to the authority wallet itself
const TREASURY   = process.env.TREASURY  || '';
const FEE_BPS    = parseInt(process.env.FEE_BPS || '500', 10); // 500 = 5%

const idl  = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../target/idl/arcadia.json'), 'utf-8'));
const secret = JSON.parse(fs.readFileSync(KEYPAIR.replace('~', process.env.HOME!), 'utf-8'));
const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));

const connection = new Connection(RPC_URL, 'confirmed');
const wallet     = new anchor.Wallet(keypair);
const provider   = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
const program: any = new Program(idl, provider);

async function main() {
  const treasury = new PublicKey(TREASURY || keypair.publicKey.toBase58());

  const [configPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('config')],
    program.programId,
  );

  console.log('Program ID :', program.programId.toBase58());
  console.log('Authority  :', keypair.publicKey.toBase58());
  console.log('Treasury   :', treasury.toBase58());
  console.log('Fee        :', FEE_BPS, 'bps =', FEE_BPS / 100, '%');
  console.log('Config PDA :', configPDA.toBase58());

  try {
    const existing = await program.account.programConfig.fetch(configPDA);
    console.log('\n✓ Config already initialised — nothing to do.');
    console.log('  authority:', existing.authority.toBase58());
    console.log('  treasury :', existing.treasury.toBase58());
    console.log('  fee_bps  :', existing.feeBps.toString());
    return;
  } catch {
    // Not yet initialised — proceed
  }

  const tx = await program.methods
    .initializeConfig(treasury, new anchor.BN(FEE_BPS))
    .accounts({
      config: configPDA,
      authority: keypair.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log('\n✓ Config initialised! tx:', tx);
}

main().catch(err => { console.error(err); process.exit(1); });
