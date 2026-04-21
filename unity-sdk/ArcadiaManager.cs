using System;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Solana.Unity.SDK;
using Solana.Unity.Rpc;
using Solana.Unity.Rpc.Models;
using Solana.Unity.Rpc.Types;

/// <summary>
/// Arcadia SDK — drop this into your Unity project alongside RoundManager.cs.
///
/// Setup:
///   1. Attach to a persistent GameObject (e.g. WalletManager) in your MainMenu scene.
///   2. Set BackendUrl in the Inspector to your hosted backend URL.
///   3. Set Cluster to match the network (devnet / mainnet-beta).
///
/// Required packages:
///   - Solana.Unity-SDK (MagicBlock): https://github.com/magicblock-labs/Solana.Unity-SDK
///   - Newtonsoft.Json: com.unity.nuget.newtonsoft-json
/// </summary>
public class ArcadiaManager : MonoBehaviour
{
    public static ArcadiaManager Instance { get; private set; }

    [Header("Backend")]
    [Tooltip("URL of the Arcadia backend (e.g. https://your-app.onrender.com)")]
    public string BackendUrl = "http://localhost:3000";

    [Header("Solana")]
    [Tooltip("Network the backend is pointed at: devnet | mainnet-beta | testnet | localnet")]
    public string Cluster = "devnet";

    private IRpcClient _rpc;

    private void Awake()
    {
        if (Instance != null && Instance != this) { Destroy(gameObject); return; }
        Instance = this;
        DontDestroyOnLoad(gameObject);
        _rpc = ClientFactory.GetClient(ClusterEndpoint());
    }

    private string ClusterEndpoint() => Cluster switch
    {
        "mainnet-beta" => "https://api.mainnet-beta.solana.com",
        "testnet"      => "https://api.testnet.solana.com",
        "devnet"       => "https://api.devnet.solana.com",
        "localnet"     => "http://127.0.0.1:8899",
        _              => Cluster,
    };

    // ── API calls ─────────────────────────────────────────────────────────────

    /// <summary>
    /// GET /api/rounds
    /// Fetch all open rounds. Call on MainMenu load to display entry fee and player count.
    /// </summary>
    public async Task<List<RoundData>> GetActiveRounds()
    {
        string json = await HttpGet($"{BackendUrl}/api/rounds");
        if (json == null) return new List<RoundData>();
        try { return JsonConvert.DeserializeObject<List<RoundData>>(json) ?? new List<RoundData>(); }
        catch (Exception e) { Debug.LogError($"[Arcadia] GetActiveRounds: {e.Message}"); return new List<RoundData>(); }
    }

    /// <summary>
    /// POST /api/rounds/:id/join
    /// Backend builds the unsigned enterRound transaction.
    /// Phantom signs it — player's entry fee moves on-chain to the round escrow.
    /// Returns true when confirmed.
    /// </summary>
    public async Task<bool> JoinRound(long roundId, string walletAddress)
    {
        var body = new JObject { ["wallet"] = walletAddress };
        string json = await HttpPost($"{BackendUrl}/api/rounds/{roundId}/join", body.ToString());
        if (json == null) return false;

        string txBase64;
        try { txBase64 = JObject.Parse(json)["transaction"]?.ToString(); }
        catch (Exception e) { Debug.LogError($"[Arcadia] JoinRound parse error: {e.Message}"); return false; }

        if (string.IsNullOrEmpty(txBase64))
        {
            Debug.LogError("[Arcadia] JoinRound: no transaction in response");
            return false;
        }

#if UNITY_EDITOR
        // Editor: skip Phantom signing so you can test the full game flow without spending SOL.
        Debug.Log($"[Arcadia] EDITOR MODE: skipping Phantom signing for round {roundId}");
        return true;
#endif

#pragma warning disable CS0162
        byte[] txBytes;
        try { txBytes = Convert.FromBase64String(txBase64); }
        catch (Exception e) { Debug.LogError($"[Arcadia] Bad base64 tx: {e.Message}"); return false; }

        Transaction tx;
        try { tx = Transaction.Deserialize(txBytes); }
        catch (Exception e) { Debug.LogError($"[Arcadia] Deserialize failed: {e.Message}"); return false; }

        // Refresh blockhash — valid for ~2 minutes
        var bh = await _rpc.GetLatestBlockHashAsync();
        if (bh.WasSuccessful)
            tx.RecentBlockHash = bh.Result.Value.Blockhash;

        try
        {
            var result = await Web3.Instance.WalletBase.SignAndSendTransaction(tx, commitment: Commitment.Confirmed);
            if (result?.WasSuccessful == true)
            {
                Debug.Log($"[Arcadia] Joined round {roundId} — tx: {result.Result}");
                return true;
            }
            Debug.LogError($"[Arcadia] JoinRound failed: {result?.Reason}");
            return false;
        }
        catch (Exception e) { Debug.LogError($"[Arcadia] JoinRound signing error: {e.Message}"); return false; }
#pragma warning restore CS0162
    }

    /// <summary>
    /// POST /api/rounds/:id/submit-score
    /// Send the player's score after the game ends.
    /// Backend commits the hash on-chain (anti-cheat). Returns true on success.
    /// </summary>
    public async Task<bool> SubmitScore(long roundId, string walletAddress, int score)
    {
        var body = new JObject { ["wallet"] = walletAddress, ["score"] = score };
        string json = await HttpPost($"{BackendUrl}/api/rounds/{roundId}/submit-score", body.ToString());
        if (json == null) return false;
        try
        {
            var resp = JObject.Parse(json);
            bool ok = resp["success"]?.Value<bool>() ?? false;
            if (!ok) Debug.LogWarning($"[Arcadia] SubmitScore rejected: {resp["error"]}");
            return ok;
        }
        catch (Exception e) { Debug.LogError($"[Arcadia] SubmitScore parse error: {e.Message}"); return false; }
    }

    /// <summary>
    /// GET /api/rounds/:id/leaderboard
    /// During open round: scores hidden, returns player count.
    /// After finalised: full sorted leaderboard with winner.
    /// </summary>
    public async Task<LeaderboardData> GetLeaderboard(long roundId)
    {
        string json = await HttpGet($"{BackendUrl}/api/rounds/{roundId}/leaderboard");
        if (json == null) return null;
        try { return JsonConvert.DeserializeObject<LeaderboardData>(json); }
        catch (Exception e) { Debug.LogError($"[Arcadia] GetLeaderboard: {e.Message}"); return null; }
    }

    /// <summary>
    /// GET /api/rounds/:id/status — round info with countdown timer.
    /// </summary>
    public async Task<RoundData> GetRoundStatus(long roundId)
    {
        string json = await HttpGet($"{BackendUrl}/api/rounds/{roundId}/status");
        if (json == null) return null;
        try { return JsonConvert.DeserializeObject<RoundData>(json); }
        catch (Exception e) { Debug.LogError($"[Arcadia] GetRoundStatus: {e.Message}"); return null; }
    }

    // ── HTTP helpers ──────────────────────────────────────────────────────────

    private async Task<string> HttpGet(string url)
    {
        using var req = UnityWebRequest.Get(url);
        await Send(req);
        if (req.result != UnityWebRequest.Result.Success)
        {
            Debug.LogError($"[Arcadia] GET {url} → {req.responseCode} {req.error}");
            return null;
        }
        return req.downloadHandler.text;
    }

    private async Task<string> HttpPost(string url, string jsonBody)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(jsonBody);
        using var req = new UnityWebRequest(url, "POST");
        req.uploadHandler   = new UploadHandlerRaw(bytes);
        req.downloadHandler = new DownloadHandlerBuffer();
        req.SetRequestHeader("Content-Type", "application/json");
        await Send(req);
        if (req.result != UnityWebRequest.Result.Success)
        {
            Debug.LogError($"[Arcadia] POST {url} → {req.responseCode} {req.error} | {req.downloadHandler.text}");
            return null;
        }
        return req.downloadHandler.text;
    }

    private Task Send(UnityWebRequest req)
    {
        var tcs = new TaskCompletionSource<bool>();
        req.SendWebRequest().completed += _ => tcs.SetResult(true);
        return tcs.Task;
    }
}

// ── Data models ───────────────────────────────────────────────────────────────

[Serializable]
public class RoundData
{
    [JsonProperty("roundId")]              public long   RoundId;
    [JsonProperty("status")]               public string Status;
    [JsonProperty("entryFee")]             public long   EntryFee;
    [JsonProperty("entryFeeSol")]          public double EntryFeeSol;
    [JsonProperty("totalPool")]            public long   TotalPool;
    [JsonProperty("totalPoolSol")]         public double TotalPoolSol;
    [JsonProperty("playerCount")]          public int    PlayerCount;
    [JsonProperty("endsAt")]               public long   EndsAt;
    [JsonProperty("timeRemainingSeconds")] public long   TimeRemainingSeconds;
    [JsonProperty("winner")]               public string Winner;
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
public class LeaderboardData
{
    [JsonProperty("roundId")]        public long                   RoundId;
    [JsonProperty("status")]         public string                 Status;
    [JsonProperty("playerCount")]    public int                    PlayerCount;
    [JsonProperty("winner")]         public string                 Winner;
    [JsonProperty("totalPoolSol")]   public double                 TotalPoolSol;
    [JsonProperty("leaderboard")]    public List<LeaderboardEntry> Leaderboard;
    [JsonProperty("scoresRevealed")] public bool                   ScoresRevealed;
    [JsonProperty("hint")]           public string                 Hint;
}
