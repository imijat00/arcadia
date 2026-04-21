# Arcadia — Deployment Guide

## Prerequisites

```bash
# Install Rust and Cargo
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Install Solana CLI (v1.18+)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Install Anchor CLI (v0.30+)
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install latest
avm use latest

# Install Node.js dependencies
npm install
```

## Step 1 — Configure Solana for Devnet

```bash
# Set cluster to devnet
solana config set --url devnet

# Generate a new keypair for deployment (or use existing)
solana-keygen new -o ~/.config/solana/arcadia-deployer.json
solana config set --keypair ~/.config/solana/arcadia-deployer.json

# Airdrop devnet SOL for deployment fees
solana airdrop 5
solana airdrop 5   # run twice, devnet limits to 5 per request
```

## Step 2 — Build the Program

```bash
# From the project root directory
anchor build

# This generates:
#   target/deploy/arcadia-keypair.json   — program keypair
#   target/deploy/arcadia.so             — compiled program
#   target/idl/arcadia.json              — IDL for client usage
#   target/types/arcadia.ts              — TypeScript types
```

## Step 3 — Get Your Program ID

```bash
# Display the program ID from the generated keypair
solana address -k target/deploy/arcadia-keypair.json
```

**Important:** Copy this address and update it in three places:

1. `programs/arcadia/src/lib.rs` → `declare_id!("YOUR_PROGRAM_ID")`
2. `Anchor.toml` → `[programs.devnet]` section
3. `client/arcadia.ts` → `PROGRAM_ID` constant

Then rebuild:
```bash
anchor build
```

## Step 4 — Deploy to Devnet

```bash
anchor deploy --provider.cluster devnet

# Expected output:
# Deploying workspace: https://api.devnet.solana.com
# Upgrade authority: ~/.config/solana/arcadia-deployer.json
# Deploying program "arcadia"...
# Program Id: <YOUR_PROGRAM_ID>
# Deploy success
```

## Step 5 — Initialize Program Config

After deployment, you must call `initialize_config` once to set the treasury
wallet and fee percentage. Use the provided script or do it manually:

```bash
# Using Anchor test framework (recommended for hackathon)
anchor test --skip-deploy

# Or create a quick init script:
npx ts-node scripts/init-config.ts
```

Example init script (`scripts/init-config.ts`):
```typescript
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.Arcadia;
const treasury = new PublicKey("YOUR_TREASURY_WALLET_HERE");

async function main() {
  const [configPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  await program.methods
    .initializeConfig(treasury, new anchor.BN(500)) // 5% fee
    .accounts({
      config: configPDA,
      authority: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("Config initialized!");
}

main().catch(console.error);
```

## Step 6 — Run the Full Test Suite

```bash
# Run all tests against a local validator
anchor test

# Or test against devnet (slower but uses deployed program)
anchor test --provider.cluster devnet --skip-deploy
```

## Step 7 — Test a Full Round Cycle Manually

```bash
# 1. Create a round (entry fee: 0.1 SOL, duration: 60 seconds)
npx ts-node scripts/create-round.ts --round-id 1 --fee 100000000 --duration 60

# 2. Enter the round with a test wallet
npx ts-node scripts/enter-round.ts --round-id 1

# 3. Commit a score
npx ts-node scripts/commit-score.ts --round-id 1 --score 420

# 4. Wait for round to expire, then close it
npx ts-node scripts/close-round.ts --round-id 1

# 5. Reveal the score
npx ts-node scripts/reveal-score.ts --round-id 1

# 6. Finalise and collect payout
npx ts-node scripts/finalise-round.ts --round-id 1
```

## Step 8 — Verify On-Chain

```bash
# Check round account data
solana account <ROUND_PDA_ADDRESS> --output json

# View program logs
solana logs <YOUR_PROGRAM_ID>

# Check transaction details
solana confirm -v <TRANSACTION_SIGNATURE>
```

## Anchor.toml Reference

```toml
[features]
seeds = false
skip-lint = false

[programs.devnet]
arcadia = "YOUR_PROGRAM_ID_HERE"

[registry]
url = "https://api.apr.dev"

[provider]
cluster = "devnet"
wallet = "~/.config/solana/arcadia-deployer.json"

[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
```

## Troubleshooting

**"Account not found"** — The PDA hasn't been initialized yet. Make sure
you've called `initialize_config` and that the round exists before entering.

**"Insufficient funds"** — Airdrop more devnet SOL: `solana airdrop 5`

**"Transaction simulation failed"** — Check program logs with
`solana logs <PROGRAM_ID>`. Common causes: wrong account order, missing
signer, or constraint violation.

**"Program too large"** — If the compiled .so exceeds the BPF limit, try
`anchor build -- --features no-entrypoint` or split into multiple programs.

## Production Checklist (Post-Hackathon)

- [ ] Replace `declare_id!` with mainnet program ID
- [ ] Set real treasury wallet in `initialize_config`
- [ ] Audit all PDA seed derivations
- [ ] Add rate limiting to backend RPC calls
- [ ] Enable session keys via MagicBlock SDK
- [ ] Set up monitoring for on-chain events
- [ ] Configure proper RPC endpoint (not public devnet)
- [ ] Security audit by a Solana-specialized firm
