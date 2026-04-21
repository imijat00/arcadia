/**
 * ArcadiaProgram.cs — Unity C# client for interacting with the Arcadia Solana program.
 *
 * Uses Solana.Unity-SDK (MagicBlock) for wallet connection, session keys,
 * and transaction signing. This class handles the two instructions players
 * call from the mobile app: enter_round and commit_score.
 *
 * SETUP:
 *   1. Import Solana.Unity-SDK via Unity Package Manager
 *   2. Add this script to a GameObject in your scene
 *   3. Configure ArcadiaProgramId with your deployed program ID
 *
 * SESSION KEY FLOW:
 *   - First connect: Phantom wallet popup (one-time)
 *   - CreateSessionToken: one approval popup (valid 1 hour, max 0.5 SOL)
 *   - All subsequent transactions signed silently by session keypair
 */

using System;
using System.Text;
using System.Security.Cryptography;
using System.Threading.Tasks;
using System.Collections.Generic;
using Solana.Unity.SDK;
using Solana.Unity.Wallet;
using Solana.Unity.Rpc;
using Solana.Unity.Rpc.Builders;
using Solana.Unity.Rpc.Models;
using Solana.Unity.Rpc.Types;
using Solana.Unity.Programs;
using UnityEngine;

namespace Arcadia
{
    /// <summary>
    /// Main interface for calling Arcadia smart contract instructions from Unity.
    /// Handles wallet connection, session keys, PDA derivation, and transaction
    /// construction for enter_round.
    /// </summary>
    public class ArcadiaProgram : MonoBehaviour
    {
        // ====================================================================
        // Configuration
        // ====================================================================

        [Header("Program Configuration")]
        [Tooltip("Deployed Arcadia program ID on Solana")]
        public string ArcadiaProgramId = "ArcD1aXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

        [Tooltip("Solana cluster: devnet, testnet, or mainnet-beta")]
        public string Cluster = "devnet";

        [Header("Session Key Settings")]
        [Tooltip("Session duration in seconds (default 1 hour)")]
        public int SessionDurationSeconds = 3600;

        [Tooltip("Max lamports per session (default 0.5 SOL)")]
        public long MaxLamportsPerSession = 500_000_000;

        // ====================================================================
        // State
        // ====================================================================

        private PublicKey _programId;
        private Account _sessionKeypair;
        private bool _sessionActive = false;

        /// <summary>Current player's connected wallet address.</summary>
        public PublicKey PlayerWallet => Web3.Account?.PublicKey;

        /// <summary>Whether a valid session key is active for silent signing.</summary>
        public bool HasActiveSession => _sessionActive && _sessionKeypair != null;

        // ====================================================================
        // Lifecycle
        // ====================================================================

        private void Awake()
        {
            _programId = new PublicKey(ArcadiaProgramId);
        }

        // ====================================================================
        // Wallet Connection
        // ====================================================================

        /// <summary>
        /// Connects the player's Phantom wallet via deep link.
        /// This triggers a single wallet popup on first connect.
        /// </summary>
        public async Task<bool> ConnectWallet()
        {
            try
            {
                var account = await Web3.Instance.LoginPhantom();
                if (account != null)
                {
                    Debug.Log($"[Arcadia] Wallet connected: {account.PublicKey}");
                    return true;
                }
                Debug.LogWarning("[Arcadia] Wallet connection failed");
                return false;
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Arcadia] Wallet error: {ex.Message}");
                return false;
            }
        }

        // ====================================================================
        // Session Key Management
        // ====================================================================

        /// <summary>
        /// Creates a session key that allows silent transaction signing for
        /// the configured duration. One wallet popup to approve, then all
        /// subsequent transactions are signed without popups.
        ///
        /// The session key is scoped to the Arcadia program only and has a
        /// maximum spend limit per session.
        /// </summary>
        public async Task<bool> CreateSession()
        {
            try
            {
                if (PlayerWallet == null)
                {
                    Debug.LogError("[Arcadia] Must connect wallet before creating session");
                    return false;
                }

                // Create session token — one popup for approval
                var sessionToken = await Web3.Instance.CreateSessionToken(
                    targetProgram: _programId,
                    validUntil: DateTimeOffset.UtcNow.AddSeconds(SessionDurationSeconds),
                    lamportsPerSession: MaxLamportsPerSession
                );

                if (sessionToken != null)
                {
                    _sessionKeypair = sessionToken.SessionKeypair;
                    _sessionActive = true;
                    Debug.Log($"[Arcadia] Session created, valid for {SessionDurationSeconds}s");
                    return true;
                }

                Debug.LogWarning("[Arcadia] Session creation failed");
                return false;
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Arcadia] Session error: {ex.Message}");
                return false;
            }
        }

        // ====================================================================
        // PDA Derivation
        // ====================================================================

        /// <summary>Derives the round escrow PDA for a given round ID.</summary>
        public PublicKey DeriveRoundPDA(ulong roundId)
        {
            byte[] roundIdBytes = BitConverter.GetBytes(roundId);
            if (!BitConverter.IsLittleEndian) Array.Reverse(roundIdBytes);

            PublicKey.TryFindProgramAddress(
                new List<byte[]> { Encoding.UTF8.GetBytes("round"), roundIdBytes },
                _programId,
                out var pda,
                out _
            );
            return pda;
        }

        /// <summary>Derives the daily record PDA for a player.</summary>
        public PublicKey DeriveDailyRecordPDA(PublicKey player)
        {
            PublicKey.TryFindProgramAddress(
                new List<byte[]> { Encoding.UTF8.GetBytes("daily"), player.KeyBytes },
                _programId,
                out var pda,
                out _
            );
            return pda;
        }

        /// <summary>Derives the score entry PDA for a player in a round.</summary>
        public PublicKey DeriveScoreEntryPDA(ulong roundId, PublicKey player)
        {
            byte[] roundIdBytes = BitConverter.GetBytes(roundId);
            if (!BitConverter.IsLittleEndian) Array.Reverse(roundIdBytes);

            PublicKey.TryFindProgramAddress(
                new List<byte[]>
                {
                    Encoding.UTF8.GetBytes("score"),
                    roundIdBytes,
                    player.KeyBytes
                },
                _programId,
                out var pda,
                out _
            );
            return pda;
        }

        // ====================================================================
        // enter_round — Player pays entry fee to join a round
        // ====================================================================

        /// <summary>
        /// Enters a round by transferring the entry fee from the player's wallet
        /// directly into the round's escrow PDA on Solana.
        ///
        /// Uses the session key for silent signing if a session is active.
        /// Falls back to wallet popup if no session.
        ///
        /// Flow:
        ///   1. Derive PDAs (round, daily record)
        ///   2. Build the enter_round instruction
        ///   3. Sign with session key (silent) or wallet (popup)
        ///   4. Send transaction to Solana
        /// </summary>
        /// <param name="roundId">The round to enter</param>
        /// <returns>Transaction signature, or null on failure</returns>
        public async Task<string> EnterRound(ulong roundId)
        {
            try
            {
                if (PlayerWallet == null)
                {
                    Debug.LogError("[Arcadia] Wallet not connected");
                    return null;
                }

                // Derive PDAs
                PublicKey roundPDA = DeriveRoundPDA(roundId);
                PublicKey dailyPDA = DeriveDailyRecordPDA(PlayerWallet);

                // Build instruction data
                // Anchor discriminator for "enter_round" + round_id (u64 LE)
                byte[] discriminator = ComputeDiscriminator("global", "enter_round");
                byte[] roundIdBytes = BitConverter.GetBytes(roundId);
                if (!BitConverter.IsLittleEndian) Array.Reverse(roundIdBytes);

                byte[] data = new byte[discriminator.Length + roundIdBytes.Length];
                Buffer.BlockCopy(discriminator, 0, data, 0, discriminator.Length);
                Buffer.BlockCopy(roundIdBytes, 0, data, discriminator.Length, roundIdBytes.Length);

                // Build account metas
                var keys = new List<AccountMeta>
                {
                    AccountMeta.Writable(roundPDA, false),           // round (mut)
                    AccountMeta.Writable(dailyPDA, false),           // daily_record (mut, init_if_needed)
                    AccountMeta.Writable(PlayerWallet, true),        // player (mut, signer)
                    AccountMeta.ReadOnly(SystemProgram.ProgramIdKey, false), // system_program
                };

                var instruction = new TransactionInstruction
                {
                    ProgramId = _programId,
                    Keys = keys,
                    Data = data,
                };

                // Get recent blockhash
                var rpcClient = ClientFactory.GetClient(Cluster == "devnet"
                    ? "https://api.devnet.solana.com"
                    : "https://api.mainnet-beta.solana.com");

                var blockHash = await rpcClient.GetLatestBlockHashAsync();

                // Build transaction
                var tx = new TransactionBuilder()
                    .SetRecentBlockHash(blockHash.Result.Value.Blockhash)
                    .SetFeePayer(PlayerWallet)
                    .AddInstruction(instruction)
                    .Build(new List<Account> { GetSigningAccount() });

                // Send
                var result = await rpcClient.SendTransactionAsync(
                    Convert.ToBase64String(tx),
                    skipPreflight: false,
                    commitment: Commitment.Confirmed
                );

                if (result.WasSuccessful)
                {
                    Debug.Log($"[Arcadia] Entered round {roundId}: {result.Result}");
                    return result.Result;
                }

                Debug.LogError($"[Arcadia] Enter round failed: {result.Reason}");
                return null;
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Arcadia] EnterRound error: {ex.Message}");
                return null;
            }
        }

        // ====================================================================
        // Helper: Signing Account Selection
        // ====================================================================

        /// <summary>
        /// Returns the session keypair if a session is active, otherwise
        /// returns the main wallet account (which will trigger a popup).
        /// </summary>
        private Account GetSigningAccount()
        {
            if (HasActiveSession)
            {
                Debug.Log("[Arcadia] Signing with session key (silent)");
                return _sessionKeypair;
            }
            Debug.Log("[Arcadia] Signing with wallet (popup)");
            return Web3.Account;
        }

        // ====================================================================
        // Helper: Anchor Instruction Discriminator
        // ====================================================================

        /// <summary>
        /// Computes the 8-byte Anchor instruction discriminator.
        /// Formula: sha256("namespace:instruction_name")[0..8]
        /// </summary>
        private byte[] ComputeDiscriminator(string ns, string name)
        {
            using var sha = SHA256.Create();
            byte[] hash = sha.ComputeHash(
                Encoding.UTF8.GetBytes($"{ns}:{name}")
            );
            byte[] disc = new byte[8];
            Buffer.BlockCopy(hash, 0, disc, 0, 8);
            return disc;
        }

        // ====================================================================
        // Leaderboard — Read on-chain state
        // ====================================================================

        /// <summary>
        /// Fetches a round's on-chain data for leaderboard display.
        /// During an active round, only 3rd place is shown (UX decision).
        /// Full leaderboard available after round is finalised.
        /// </summary>
        public async Task<RoundInfo> FetchRoundInfo(ulong roundId)
        {
            try
            {
                PublicKey roundPDA = DeriveRoundPDA(roundId);

                var rpcClient = ClientFactory.GetClient(Cluster == "devnet"
                    ? "https://api.devnet.solana.com"
                    : "https://api.mainnet-beta.solana.com");

                var accountInfo = await rpcClient.GetAccountInfoAsync(
                    roundPDA.Key,
                    Commitment.Confirmed
                );

                if (accountInfo.Result?.Value?.Data == null)
                    return null;

                // Decode account data (skip 8-byte discriminator)
                byte[] rawData = Convert.FromBase64String(
                    accountInfo.Result.Value.Data[0]
                );

                // Parse basic fields from raw bytes
                // This is a simplified parser — in production, use generated IDL types
                var info = new RoundInfo
                {
                    RoundId = roundId,
                    TotalPool = BitConverter.ToUInt64(rawData, 8 + 8 + 32 + 8),
                    PlayerCount = BitConverter.ToUInt64(rawData, 8 + 8 + 32 + 8 + 8),
                };

                return info;
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Arcadia] FetchRound error: {ex.Message}");
                return null;
            }
        }
    }

    // ========================================================================
    // Data Models
    // ========================================================================

    /// <summary>On-chain round information for UI display.</summary>
    [Serializable]
    public class RoundInfo
    {
        public ulong RoundId;
        public ulong TotalPool;
        public ulong PlayerCount;
        public string Status;
        public string Winner;
    }
}
