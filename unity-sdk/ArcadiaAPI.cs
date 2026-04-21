/**
 * ArcadiaAPI.cs — Drop-in Unity SDK for the Arcadia gaming platform.
 *
 * SETUP:
 *   1. Import Solana.Unity-SDK via Unity Package Manager (com.solana.unity-sdk)
 *   2. Import Newtonsoft.Json (com.unity.nuget.newtonsoft-json)
 *   3. Attach this script to a persistent GameObject (e.g. GameManager)
 *   4. Set BackendUrl to your deployed backend (e.g. http://localhost:3000)
 *
 * FLOW:
 *   ConnectWallet()       → Phantom deep link (one wallet popup)
 *   GetActiveRounds()     → List rounds available to join
 *   JoinRound(roundId)    → Backend builds tx → Phantom signs → sent to Solana
 *   SubmitScore(id, n)    → POST score to backend (committed on-chain by backend)
 *   GetLeaderboard(id)    → Scores hidden during round, revealed after
 *
 * WALLET SECURITY:
 *   The player's private key never leaves their device.
 *   Only enter_round requires the player's signature.
 *   All other on-chain calls are made by the backend authority wallet.
 */

using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Solana.Unity.SDK;
using Solana.Unity.Wallet;
using Solana.Unity.Rpc;
using Solana.Unity.Rpc.Builders;
using Solana.Unity.Rpc.Models;
using Solana.Unity.Rpc.Types;

namespace Arcadia
{
    /// <summary>
    /// Main Arcadia API client. Attach to a persistent GameObject.
    /// All public methods are async and safe to await from UI code.
    /// </summary>
    public class ArcadiaAPI : MonoBehaviour
    {
        // =====================================================================
        // Configuration — set in Inspector or via code before first call
        // =====================================================================

        [Header("Backend")]
        [Tooltip("Base URL of the Arcadia backend API")]
        public string BackendUrl = "http://localhost:3000";

        [Header("Solana")]
        [Tooltip("Solana cluster: devnet | mainnet-beta | localnet")]
        public string Cluster = "devnet";

        // =====================================================================
        // State
        // =====================================================================

        private IRpcClient _rpc;

        /// <summary>The connected player wallet, or null if not connected.</summary>
        public Account PlayerWallet => Web3.Account;

        /// <summary>True when a wallet is connected.</summary>
        public bool IsConnected => PlayerWallet != null;

        // =====================================================================
        // Lifecycle
        // =====================================================================

        private void Awake()
        {
            _rpc = ClientFactory.GetClient(ClusterEndpoint());
        }

        private string ClusterEndpoint() => Cluster switch
        {
            "mainnet-beta" => "https://api.mainnet-beta.solana.com",
            "devnet"       => "https://api.devnet.solana.com",
            "localnet"     => "http://127.0.0.1:8899",
            _              => Cluster, // allow custom RPC URL
        };

        // =====================================================================
        // 1. ConnectWallet — Phantom deep link
        // =====================================================================

        /// <summary>
        /// Opens Phantom wallet for connection. Shows one approval popup.
        /// Returns the connected wallet address, or null on failure.
        /// </summary>
        public async Task<string> ConnectWallet()
        {
            try
            {
                var account = await Web3.Instance.LoginPhantom();
                if (account == null)
                {
                    Debug.LogWarning("[Arcadia] Wallet connection cancelled");
                    return null;
                }

                Debug.Log($"[Arcadia] Connected: {account.PublicKey}");
                return account.PublicKey.Key;
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Arcadia] ConnectWallet error: {ex.Message}");
                return null;
            }
        }

        // =====================================================================
        // 2. GetActiveRounds — List open rounds
        // =====================================================================

        /// <summary>
        /// Fetches all active (open + closed) rounds from the backend.
        /// Returns a list of round objects.
        /// </summary>
        public async Task<List<RoundInfo>> GetActiveRounds()
        {
            string json = await HttpGet($"{BackendUrl}/api/rounds");
            if (json == null) return new List<RoundInfo>();

            try
            {
                return JsonConvert.DeserializeObject<List<RoundInfo>>(json)
                       ?? new List<RoundInfo>();
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Arcadia] GetActiveRounds parse error: {ex.Message}");
                return new List<RoundInfo>();
            }
        }

        // =====================================================================
        // 3. JoinRound — Enter the round (entry fee payment)
        // =====================================================================

        /// <summary>
        /// Enters a round: calls backend to get the unsigned transaction,
        /// signs it with the player's Phantom wallet, and sends it to Solana.
        ///
        /// The entry fee (SOL) goes directly from the player's wallet to the
        /// on-chain escrow PDA. The backend never holds player funds.
        ///
        /// Returns the transaction signature, or null on failure.
        /// </summary>
        public async Task<string> JoinRound(long roundId)
        {
            if (!IsConnected)
            {
                Debug.LogError("[Arcadia] Wallet not connected — call ConnectWallet() first");
                return null;
            }

            try
            {
                // Step 1: Backend builds the unsigned enter_round transaction
                var joinBody = new JObject
                {
                    ["wallet"] = PlayerWallet.PublicKey.Key,
                };

                string joinJson = await HttpPost(
                    $"{BackendUrl}/api/rounds/{roundId}/join",
                    joinBody.ToString()
                );
                if (joinJson == null) return null;

                var joinResp = JObject.Parse(joinJson);
                string txBase64 = joinResp["transaction"]?.ToString();
                if (string.IsNullOrEmpty(txBase64))
                {
                    Debug.LogError("[Arcadia] JoinRound: no transaction in response");
                    return null;
                }

                // Step 2: Deserialize the transaction
                byte[] txBytes = Convert.FromBase64String(txBase64);

                // Step 3: Get a fresh blockhash (the one from backend may be stale)
                var blockHashResp = await _rpc.GetLatestBlockHashAsync();
                if (!blockHashResp.WasSuccessful)
                {
                    Debug.LogError($"[Arcadia] GetLatestBlockHash failed: {blockHashResp.Reason}");
                    return null;
                }

                // Step 4: Sign with the player's wallet (Phantom popup / session key)
                var tx = Transaction.Deserialize(txBytes);
                tx.RecentBlockHash = blockHashResp.Result.Value.Blockhash;

                // Web3.Account is the connected wallet — signs without external popup
                // if a session key is active, or shows a Phantom approval popup otherwise.
                tx.Sign(new List<Account> { PlayerWallet });

                // Step 5: Send the signed transaction to Solana
                var sendResp = await _rpc.SendTransactionAsync(
                    Convert.ToBase64String(tx.Serialize()),
                    skipPreflight: false,
                    commitment: Commitment.Confirmed
                );

                if (sendResp.WasSuccessful)
                {
                    Debug.Log($"[Arcadia] Joined round {roundId}: {sendResp.Result}");
                    return sendResp.Result;
                }

                Debug.LogError($"[Arcadia] JoinRound send failed: {sendResp.Reason}");
                return null;
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Arcadia] JoinRound error: {ex.Message}");
                return null;
            }
        }

        // =====================================================================
        // 4. SubmitScore — Send score to backend after game ends
        // =====================================================================

        /// <summary>
        /// Sends the player's score to the backend after a game session ends.
        /// The backend validates the score, generates a secret salt,
        /// and commits sha256(score:wallet:roundId:salt) to the blockchain.
        ///
        /// The actual score is hidden on-chain until the round closes
        /// (commit-reveal scheme). The salt is only ever known to the backend.
        ///
        /// Returns true on success.
        /// </summary>
        public async Task<bool> SubmitScore(long roundId, int score)
        {
            if (!IsConnected)
            {
                Debug.LogError("[Arcadia] Wallet not connected");
                return false;
            }

            try
            {
                var body = new JObject
                {
                    ["wallet"] = PlayerWallet.PublicKey.Key,
                    ["score"]  = score,
                };

                string json = await HttpPost(
                    $"{BackendUrl}/api/rounds/{roundId}/submit-score",
                    body.ToString()
                );

                if (json == null) return false;

                var resp = JObject.Parse(json);
                bool success = resp["success"]?.Value<bool>() ?? false;

                if (success)
                    Debug.Log($"[Arcadia] Score submitted for round {roundId}");
                else
                    Debug.LogWarning($"[Arcadia] Score submission failed: {resp["error"]}");

                return success;
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Arcadia] SubmitScore error: {ex.Message}");
                return false;
            }
        }

        // =====================================================================
        // 5. GetLeaderboard — Fetch leaderboard for a round
        // =====================================================================

        /// <summary>
        /// Fetches the leaderboard for a round.
        ///
        /// During an open round: scores are hidden (commit-reveal anti-cheat).
        ///   Returns player count and whether 3rd place exists.
        ///
        /// After finalisation: full sorted leaderboard with scores and winner.
        /// </summary>
        public async Task<LeaderboardInfo> GetLeaderboard(long roundId)
        {
            string json = await HttpGet($"{BackendUrl}/api/rounds/{roundId}/leaderboard");
            if (json == null) return null;

            try
            {
                return JsonConvert.DeserializeObject<LeaderboardInfo>(json);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Arcadia] GetLeaderboard parse error: {ex.Message}");
                return null;
            }
        }

        // =====================================================================
        // 6. GetRoundStatus — Countdown timer and phase
        // =====================================================================

        /// <summary>
        /// Returns detailed round status including countdown timer.
        /// </summary>
        public async Task<RoundStatus> GetRoundStatus(long roundId)
        {
            string json = await HttpGet($"{BackendUrl}/api/rounds/{roundId}/status");
            if (json == null) return null;

            try
            {
                return JsonConvert.DeserializeObject<RoundStatus>(json);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Arcadia] GetRoundStatus parse error: {ex.Message}");
                return null;
            }
        }

        // =====================================================================
        // 7. GetPlayerBalance — SOL balance
        // =====================================================================

        /// <summary>
        /// Returns the player's current SOL balance, or -1 on error.
        /// </summary>
        public async Task<double> GetPlayerBalance()
        {
            if (!IsConnected) return -1;

            var result = await _rpc.GetBalanceAsync(
                PlayerWallet.PublicKey.Key,
                Commitment.Confirmed
            );

            if (!result.WasSuccessful) return -1;

            return result.Result.Value / 1_000_000_000.0; // lamports → SOL
        }

        // =====================================================================
        // HTTP Helpers
        // =====================================================================

        private async Task<string> HttpGet(string url)
        {
            using var req = UnityWebRequest.Get(url);
            req.SetRequestHeader("Content-Type", "application/json");
            await SendWebRequest(req);

            if (req.result != UnityWebRequest.Result.Success)
            {
                Debug.LogError($"[Arcadia] GET {url} failed: {req.error} — {req.downloadHandler.text}");
                return null;
            }
            return req.downloadHandler.text;
        }

        private async Task<string> HttpPost(string url, string jsonBody)
        {
            byte[] bodyBytes = Encoding.UTF8.GetBytes(jsonBody);
            using var req = new UnityWebRequest(url, "POST");
            req.uploadHandler = new UploadHandlerRaw(bodyBytes);
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Content-Type", "application/json");
            await SendWebRequest(req);

            if (req.result != UnityWebRequest.Result.Success)
            {
                Debug.LogError($"[Arcadia] POST {url} failed: {req.error} — {req.downloadHandler.text}");
                return null;
            }
            return req.downloadHandler.text;
        }

        private Task SendWebRequest(UnityWebRequest req)
        {
            var tcs = new TaskCompletionSource<bool>();
            var op = req.SendWebRequest();
            op.completed += _ => tcs.SetResult(true);
            return tcs.Task;
        }
    }

    // =========================================================================
    // Data models (match backend API response shapes)
    // =========================================================================

    [Serializable]
    public class RoundInfo
    {
        [JsonProperty("roundId")]      public long   RoundId;
        [JsonProperty("status")]       public string Status;
        [JsonProperty("entryFee")]     public long   EntryFee;
        [JsonProperty("entryFeeSol")]  public double EntryFeeSol;
        [JsonProperty("totalPool")]    public long   TotalPool;
        [JsonProperty("totalPoolSol")] public double TotalPoolSol;
        [JsonProperty("playerCount")]  public int    PlayerCount;
        [JsonProperty("endsAt")]       public long   EndsAt;
        [JsonProperty("timeRemainingSeconds")] public long TimeRemainingSeconds;
        [JsonProperty("winner")]       public string Winner;
    }

    [Serializable]
    public class LeaderboardEntry
    {
        [JsonProperty("rank")]     public int    Rank;
        [JsonProperty("wallet")]   public string Wallet;
        [JsonProperty("score")]    public int?   Score;
        [JsonProperty("isWinner")] public bool   IsWinner;
    }

    [Serializable]
    public class LeaderboardInfo
    {
        [JsonProperty("roundId")]        public long                 RoundId;
        [JsonProperty("status")]         public string               Status;
        [JsonProperty("playerCount")]    public int                  PlayerCount;
        [JsonProperty("winner")]         public string               Winner;
        [JsonProperty("totalPoolSol")]   public double               TotalPoolSol;
        [JsonProperty("leaderboard")]    public List<LeaderboardEntry> Leaderboard;
        [JsonProperty("scoresRevealed")] public bool                 ScoresRevealed;
        [JsonProperty("hint")]           public string               Hint;
    }

    [Serializable]
    public class Countdown
    {
        [JsonProperty("roundEnds")]          public long   RoundEnds;
        [JsonProperty("revealDeadline")]     public long   RevealDeadline;
        [JsonProperty("roundEndsFormatted")] public string RoundEndsFormatted;
    }

    [Serializable]
    public class RoundStatus : RoundInfo
    {
        [JsonProperty("phase")]     public string   Phase;
        [JsonProperty("countdown")] public Countdown Countdown;
    }
}
