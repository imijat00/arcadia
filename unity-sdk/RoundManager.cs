using System;
using System.Collections;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEngine;

/// <summary>
/// Drop-in round lifecycle manager for Arcadia.
///
/// Setup:
///   1. Add to a persistent GameObject (same scene as ArcadiaManager).
///   2. Call ConnectWallet() after the player connects their Phantom wallet.
///   3. Call StartRoundFlow() to join and play.
///   4. At game-over call SubmitPlayerScore(score).
///
/// The component drives itself through the round states; hook the UnityEvents
/// (OnRoundJoined, OnScoreSubmitted, OnLeaderboardReady) to update your UI.
/// </summary>
public class RoundManager : MonoBehaviour
{
    public static RoundManager Instance { get; private set; }

    // ── Inspector ──────────────────────────────────────────────────────────────

    [Header("Auto-poll")]
    [Tooltip("Seconds between leaderboard polls after score submission")]
    public float PollIntervalSeconds = 5f;

    // ── Runtime state ──────────────────────────────────────────────────────────

    public string  WalletAddress   { get; private set; }
    public long    ActiveRoundId   { get; private set; } = -1;
    public bool    HasJoinedRound  { get; private set; }
    public bool    HasSubmitScore  { get; private set; }
    public RoundData CurrentRound  { get; private set; }

    // ── Events — wire these to your UI ─────────────────────────────────────────

    public event Action<List<RoundData>>   OnRoundsLoaded;
    public event Action<RoundData>         OnRoundJoined;
    public event Action                    OnJoinFailed;
    public event Action                    OnScoreSubmitted;
    public event Action                    OnScoreSubmitFailed;
    public event Action<LeaderboardData>   OnLeaderboardReady;

    // ── Internals ──────────────────────────────────────────────────────────────

    private Coroutine _pollCoroutine;

    private void Awake()
    {
        if (Instance != null && Instance != this) { Destroy(gameObject); return; }
        Instance = this;
        DontDestroyOnLoad(gameObject);
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Call this once the player's wallet is connected and you have the address.
    /// </summary>
    public void ConnectWallet(string walletAddress)
    {
        WalletAddress = walletAddress;
        Debug.Log($"[RoundManager] Wallet connected: {walletAddress}");
    }

    /// <summary>
    /// Load all open rounds and fire OnRoundsLoaded. Call on main-menu open.
    /// </summary>
    public async Task LoadRounds()
    {
        var rounds = await ArcadiaManager.Instance.GetActiveRounds();
        OnRoundsLoaded?.Invoke(rounds);
    }

    /// <summary>
    /// Join the first open round (or the round with the given id).
    /// Fires OnRoundJoined on success, OnJoinFailed on failure.
    /// </summary>
    public async Task JoinRound(long roundId = -1)
    {
        if (string.IsNullOrEmpty(WalletAddress))
        {
            Debug.LogError("[RoundManager] No wallet connected — call ConnectWallet() first.");
            OnJoinFailed?.Invoke();
            return;
        }

        if (roundId < 0)
        {
            var rounds = await ArcadiaManager.Instance.GetActiveRounds();
            if (rounds == null || rounds.Count == 0)
            {
                Debug.LogWarning("[RoundManager] No open rounds.");
                OnJoinFailed?.Invoke();
                return;
            }
            roundId = rounds[0].RoundId;
        }

        bool ok = await ArcadiaManager.Instance.JoinRound(roundId, WalletAddress);
        if (!ok)
        {
            OnJoinFailed?.Invoke();
            return;
        }

        ActiveRoundId  = roundId;
        HasJoinedRound = true;
        HasSubmitScore = false;

        CurrentRound = await ArcadiaManager.Instance.GetRoundStatus(roundId);
        OnRoundJoined?.Invoke(CurrentRound);
        Debug.Log($"[RoundManager] Joined round {roundId}");
    }

    /// <summary>
    /// Submit the player's score. Call this at game-over.
    /// Fires OnScoreSubmitted, then begins polling the leaderboard.
    /// </summary>
    public async Task SubmitPlayerScore(int score)
    {
        if (ActiveRoundId < 0 || !HasJoinedRound)
        {
            Debug.LogError("[RoundManager] Cannot submit score — not joined a round.");
            OnScoreSubmitFailed?.Invoke();
            return;
        }
        if (HasSubmitScore)
        {
            Debug.LogWarning("[RoundManager] Score already submitted for this round.");
            return;
        }

        bool ok = await ArcadiaManager.Instance.SubmitScore(ActiveRoundId, WalletAddress, score);
        if (!ok)
        {
            OnScoreSubmitFailed?.Invoke();
            return;
        }

        HasSubmitScore = true;
        OnScoreSubmitted?.Invoke();
        Debug.Log($"[RoundManager] Score {score} submitted for round {ActiveRoundId}");

        StartLeaderboardPolling();
    }

    /// <summary>
    /// Manually fetch the leaderboard once (no poll loop).
    /// </summary>
    public async Task<LeaderboardData> FetchLeaderboard()
    {
        if (ActiveRoundId < 0) return null;
        return await ArcadiaManager.Instance.GetLeaderboard(ActiveRoundId);
    }

    /// <summary>
    /// Stop the leaderboard poll loop (e.g. when player returns to main menu).
    /// </summary>
    public void StopLeaderboardPolling()
    {
        if (_pollCoroutine != null) { StopCoroutine(_pollCoroutine); _pollCoroutine = null; }
    }

    /// <summary>
    /// Reset state so the player can join the next round.
    /// </summary>
    public void ResetForNextRound()
    {
        StopLeaderboardPolling();
        ActiveRoundId  = -1;
        HasJoinedRound = false;
        HasSubmitScore = false;
        CurrentRound   = null;
    }

    // ── Internal poll loop ─────────────────────────────────────────────────────

    private void StartLeaderboardPolling()
    {
        StopLeaderboardPolling();
        _pollCoroutine = StartCoroutine(PollLeaderboard());
    }

    private IEnumerator PollLeaderboard()
    {
        while (true)
        {
            yield return new WaitForSeconds(PollIntervalSeconds);

            var task = ArcadiaManager.Instance.GetLeaderboard(ActiveRoundId);
            yield return new WaitUntil(() => task.IsCompleted);

            var data = task.Result;
            if (data == null) continue;

            OnLeaderboardReady?.Invoke(data);

            // Stop polling once the round is finalised
            if (data.Status == "finalised")
            {
                Debug.Log($"[RoundManager] Round {ActiveRoundId} finalised. Winner: {data.Winner}");
                StopLeaderboardPolling();
                yield break;
            }
        }
    }
}
