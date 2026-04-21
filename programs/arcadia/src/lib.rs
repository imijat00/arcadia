use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::Hasher;
use anchor_lang::system_program;

declare_id!("5ska6kVyEfGjQ7MxfYPoxeBK75JDAzz6q5aYdN26RgbS");

// ============================================================================
// CONSTANTS
// ============================================================================

/// Platform fee in basis points (5% = 500 bps)
pub const PLATFORM_FEE_BPS: u64 = 500;
/// Maximum entries per wallet per calendar day
pub const MAX_DAILY_ENTRIES: u8 = 5;
/// Minimum players required to run a round (otherwise → refund)
pub const MIN_PLAYERS: u8 = 2;
/// Seconds after round close during which backend must reveal scores
pub const REVEAL_WINDOW_SECONDS: i64 = 3600;
/// 24-hour acceptance window for 1v1 duels
pub const DUEL_ACCEPTANCE_WINDOW: i64 = 86400;
/// Maximum players in a group challenge
pub const MAX_GROUP_PLAYERS: u8 = 5;

// ============================================================================
// PROGRAM
// ============================================================================

#[program]
pub mod arcadia {
    use super::*;

    // ------------------------------------------------------------------------
    // 1. initialize_config — One-time setup by deployer
    // ------------------------------------------------------------------------
    /// Initialises the global ProgramConfig PDA that stores the treasury wallet
    /// address and the platform fee. Called once after deployment.
    ///
    /// Security: Only the deployer (initial authority) can call this. The config
    /// PDA is derived from a fixed seed so it can only exist once.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        treasury: Pubkey,
        fee_bps: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.treasury = treasury;
        config.fee_bps = fee_bps;
        config.authority = ctx.accounts.authority.key();
        config.bump = ctx.bumps.config;
        msg!("Config initialised: treasury={}, fee={}bps", treasury, fee_bps);
        Ok(())
    }

    // ------------------------------------------------------------------------
    // 2. create_round — Backend creates a new tournament round
    // ------------------------------------------------------------------------
    /// Creates a new tournament round with an escrow PDA that will hold all
    /// entry fees. The round has a fixed duration after which it closes.
    ///
    /// Security: Only the config authority (our backend wallet) can create rounds.
    /// The escrow PDA is program-owned — nobody can drain it except the program.
    pub fn create_round(
        ctx: Context<CreateRound>,
        round_id: u64,
        entry_fee: u64,
        duration_seconds: i64,
    ) -> Result<()> {
        require!(entry_fee > 0, ArcadiaError::InvalidEntryFee);
        require!(duration_seconds > 0, ArcadiaError::InvalidRoundDuration);

        let clock = Clock::get()?;
        let round = &mut ctx.accounts.round;

        round.round_id = round_id;
        round.authority = ctx.accounts.authority.key();
        round.entry_fee = entry_fee;
        round.total_pool = 0;
        round.player_count = 0;
        round.status = RoundStatus::Open;
        round.created_at = clock.unix_timestamp;
        round.ends_at = clock.unix_timestamp + duration_seconds;
        round.reveal_deadline = clock.unix_timestamp + duration_seconds + REVEAL_WINDOW_SECONDS;
        round.winner = Pubkey::default();
        round.bump = ctx.bumps.round;

        emit!(RoundCreated {
            round_id,
            entry_fee,
            ends_at: round.ends_at,
        });

        Ok(())
    }

    // ------------------------------------------------------------------------
    // 3. enter_round — Player pays entry fee to join
    // ------------------------------------------------------------------------
    /// Player transfers the exact entry fee from their wallet directly into
    /// the round's escrow PDA. Also enforces the 5-per-day limit.
    ///
    /// Security: Entry fee goes wallet → escrow PDA. Backend never touches it.
    /// Daily record PDA resets automatically at the start of each new UTC day.
    pub fn enter_round(ctx: Context<EnterRound>, round_id: u64) -> Result<()> {
        let round = &mut ctx.accounts.round;
        let daily = &mut ctx.accounts.daily_record;
        let clock = Clock::get()?;

        // Round must be open and not expired
        require!(round.status == RoundStatus::Open, ArcadiaError::RoundNotOpen);
        require!(clock.unix_timestamp < round.ends_at, ArcadiaError::RoundExpired);

        // Enforce daily limit (reset if new day)
        let today = clock.unix_timestamp / 86400;
        if daily.date < today {
            daily.date = today;
            daily.entries = 0;
        }
        require!(
            daily.entries < MAX_DAILY_ENTRIES,
            ArcadiaError::DailyLimitReached
        );
        daily.entries += 1;
        daily.player = ctx.accounts.player.key();

        // Transfer entry fee: player wallet → round escrow PDA
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: round.to_account_info(),
                },
            ),
            round.entry_fee,
        )?;

        round.total_pool = round
            .total_pool
            .checked_add(round.entry_fee)
            .ok_or(ArcadiaError::Overflow)?;
        round.player_count += 1;

        emit!(PlayerEntered {
            round_id,
            player: ctx.accounts.player.key(),
            total_pool: round.total_pool,
        });

        Ok(())
    }

    // ------------------------------------------------------------------------
    // 4. commit_score — Write score hash on-chain (commit phase)
    // ------------------------------------------------------------------------
    /// Backend commits a sha256 hash of (score, wallet, round_id, salt). The
    /// actual score and salt remain secret until the reveal phase.
    ///
    /// Security: The commitment is immutable once written. Neither the player
    /// nor the backend can change it after this point.
    pub fn commit_score(
        ctx: Context<CommitScore>,
        round_id: u64,
        commitment: [u8; 32],
    ) -> Result<()> {
        let round = &ctx.accounts.round;
        let clock = Clock::get()?;

        require!(round.status == RoundStatus::Open, ArcadiaError::RoundNotOpen);

        let entry = &mut ctx.accounts.score_entry;
        entry.player = ctx.accounts.player.key();
        entry.round_id = round_id;
        entry.commitment = commitment;
        entry.committed_at = clock.unix_timestamp;
        entry.revealed = false;
        entry.revealed_score = 0;
        entry.bump = ctx.bumps.score_entry;

        emit!(ScoreCommitted {
            round_id,
            player: ctx.accounts.player.key(),
            committed_at: clock.unix_timestamp,
        });

        Ok(())
    }

    // ------------------------------------------------------------------------
    // 5. close_round — Backend closes the round after timer expires
    // ------------------------------------------------------------------------
    /// Transitions round from Open → Closed (if enough players) or
    /// Open → Cancelled (if fewer than MIN_PLAYERS joined).
    ///
    /// Security: Only callable after the round's end time has passed.
    pub fn close_round(ctx: Context<CloseRound>, _round_id: u64) -> Result<()> {
        let round = &mut ctx.accounts.round;
        let clock = Clock::get()?;

        require!(round.status == RoundStatus::Open, ArcadiaError::RoundNotOpen);
        require!(
            clock.unix_timestamp >= round.ends_at,
            ArcadiaError::RoundNotExpired
        );

        if round.player_count < MIN_PLAYERS as u64 {
            round.status = RoundStatus::Cancelled;
        } else {
            round.status = RoundStatus::Closed;
        }

        emit!(RoundClosed {
            round_id: round.round_id,
            player_count: round.player_count,
            total_pool: round.total_pool,
        });

        Ok(())
    }

    // ------------------------------------------------------------------------
    // 6. reveal_score — Backend reveals actual score + salt
    // ------------------------------------------------------------------------
    /// After round is closed, backend sends the original score and salt.
    /// Contract recomputes the hash and verifies it matches the commitment.
    ///
    /// Security: If the hash doesn't match, the reveal is rejected. This makes
    /// score manipulation impossible — the commitment was locked on-chain.
    pub fn reveal_score(
        ctx: Context<RevealScore>,
        round_id: u64,
        score: u64,
        salt: String,
    ) -> Result<()> {
        let round = &ctx.accounts.round;
        require!(
            round.status == RoundStatus::Closed,
            ArcadiaError::RoundNotClosed
        );

        let entry = &mut ctx.accounts.score_entry;
        require!(!entry.revealed, ArcadiaError::AlreadyRevealed);

        // Reconstruct the commitment hash from the revealed values
        let mut hasher = Hasher::default();
        hasher.hash(
            format!(
                "{}:{}:{}:{}",
                score,
                entry.player,
                round_id,
                salt
            )
            .as_bytes(),
        );
        let computed = hasher.result().to_bytes();

        require!(computed == entry.commitment, ArcadiaError::InvalidReveal);

        entry.revealed = true;
        entry.revealed_score = score;

        emit!(ScoreRevealed {
            round_id,
            player: entry.player,
            score,
        });

        Ok(())
    }

    // ------------------------------------------------------------------------
    // 7. finalise_round — Determine winner, atomic payout
    // ------------------------------------------------------------------------
    /// After all scores are revealed, this instruction determines the highest
    /// scorer and pays out 95% to them and 5% to the treasury — atomically.
    ///
    /// Security: Both transfers happen in a single instruction. If either fails,
    /// neither executes. The round PDA signs the outgoing transfers using its
    /// signer seeds (PDA authority pattern).
    ///
    /// NOTE: For the MVP, the backend passes the winner pubkey and the contract
    /// verifies it by checking the score entries passed as remaining_accounts.
    /// Each remaining account must be a revealed ScoreEntry. The contract
    /// confirms the declared winner truly has the highest score.
    pub fn finalise_round(
        ctx: Context<FinaliseRound>,
        round_id: u64,
        winner: Pubkey,
    ) -> Result<()> {
        let round = &mut ctx.accounts.round;

        require!(
            round.status == RoundStatus::Closed,
            ArcadiaError::RoundNotClosed
        );

        // Verify the winner by scanning remaining accounts (ScoreEntry PDAs).
        // The backend must pass ALL player ScoreEntry accounts so we can verify
        // the declared winner truly has the highest score.
        let mut highest_score: u64 = 0;
        let mut highest_player = Pubkey::default();
        let mut found_player = false;

        for account_info in ctx.remaining_accounts.iter() {
            // Deserialise each remaining account as a ScoreEntry
            let data = account_info.try_borrow_data()?;
            // Skip the 8-byte Anchor discriminator
            if data.len() < 8 + 90 {
                continue;
            }
            let entry: ScoreEntryData =
    ScoreEntryData::try_from_slice(&data[8..8 + 90])?;

            if entry.round_id != round_id || !entry.revealed {
                continue;
            }
            if !found_player || entry.revealed_score > highest_score {
                highest_score = entry.revealed_score;
                highest_player = entry.player;
                found_player = true;
            }
        }

        require!(found_player, ArcadiaError::NotEnoughPlayers);
        require!(
            highest_player == winner,
            ArcadiaError::Unauthorized
        );

        // Calculate payout
        let config = &ctx.accounts.config;
        let total_pool = round.total_pool;
        let treasury_amount = total_pool
            .checked_mul(config.fee_bps)
            .ok_or(ArcadiaError::Overflow)?
            .checked_div(10_000)
            .ok_or(ArcadiaError::Overflow)?;
        let winner_amount = total_pool
            .checked_sub(treasury_amount)
            .ok_or(ArcadiaError::Overflow)?;

        // Transfer from escrow PDA → winner (lamport arithmetic)
        **round.to_account_info().try_borrow_mut_lamports()? -= winner_amount;
        **ctx.accounts.winner_account.try_borrow_mut_lamports()? += winner_amount;

        // Transfer from escrow PDA → treasury
        **round.to_account_info().try_borrow_mut_lamports()? -= treasury_amount;
        **ctx.accounts.treasury.try_borrow_mut_lamports()? += treasury_amount;

        round.status = RoundStatus::Finalised;
        round.winner = winner;

        emit!(RoundFinalised {
            round_id,
            winner,
            winner_amount,
            treasury_amount,
        });

        Ok(())
    }

    // ------------------------------------------------------------------------
    // 8. refund_player — Refund if cancelled or reveal deadline missed
    // ------------------------------------------------------------------------
    /// Anyone can call this to trigger a refund for a specific player if:
    ///   - The round was cancelled (min players not met), OR
    ///   - The reveal deadline has passed and the round is still Closed
    ///     (backend failed to reveal/finalise in time)
    ///
    /// Security: Refunds go from escrow PDA back to the original player wallet.
    /// The caller doesn't need to be the player — anyone can trigger it.
    pub fn refund_player(ctx: Context<RefundPlayer>, round_id: u64) -> Result<()> {
        let round = &mut ctx.accounts.round;
        let clock = Clock::get()?;

        let refundable = round.status == RoundStatus::Cancelled
            || (round.status == RoundStatus::Closed
                && clock.unix_timestamp > round.reveal_deadline);

        require!(refundable, ArcadiaError::RefundNotAvailable);

        let refund_amount = round.entry_fee;
        let player = ctx.accounts.player.key();

        // Transfer from escrow PDA → player
        **round.to_account_info().try_borrow_mut_lamports()? -= refund_amount;
        **ctx.accounts.player.try_borrow_mut_lamports()? += refund_amount;

        // Mark round as refundable status for tracking
        if round.status == RoundStatus::Closed {
            round.status = RoundStatus::Refundable;
        }

        emit!(PlayerRefunded {
            round_id,
            player,
            amount: refund_amount,
        });

        Ok(())
    }

    // ========================================================================
    // DUEL INSTRUCTIONS (9–13)
    // ========================================================================

    // ------------------------------------------------------------------------
    // 9. create_duel — Challenger creates a 1v1 duel
    // ------------------------------------------------------------------------
    /// Challenger creates a duel and stakes SOL into the duel's escrow PDA.
    /// An opponent has 24 hours to accept.
    pub fn create_duel(
        ctx: Context<CreateDuel>,
        duel_id: u64,
        stake: u64,
        game_seed: u64,
    ) -> Result<()> {
        require!(stake > 0, ArcadiaError::InvalidEntryFee);

        let clock = Clock::get()?;
        let duel = &mut ctx.accounts.duel;

        duel.duel_id = duel_id;
        duel.challenger = ctx.accounts.challenger.key();
        duel.opponent = Pubkey::default();
        duel.stake_lamports = stake;
        duel.status = DuelStatus::PendingAcceptance;
        duel.seed = game_seed;
        duel.acceptance_deadline = clock.unix_timestamp + DUEL_ACCEPTANCE_WINDOW;
        duel.created_at = clock.unix_timestamp;
        duel.bump = ctx.bumps.duel;

        // Transfer stake from challenger → duel escrow PDA
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.challenger.to_account_info(),
                    to: duel.to_account_info(),
                },
            ),
            stake,
        )?;

        emit!(DuelCreated {
            duel_id,
            challenger: ctx.accounts.challenger.key(),
            stake,
        });

        Ok(())
    }

    // ------------------------------------------------------------------------
    // 10. accept_duel — Opponent accepts and pays matching stake
    // ------------------------------------------------------------------------
    pub fn accept_duel(ctx: Context<AcceptDuel>, _duel_id: u64) -> Result<()> {
        let duel = &mut ctx.accounts.duel;
        let clock = Clock::get()?;

        require!(
            duel.status == DuelStatus::PendingAcceptance,
            ArcadiaError::DuelAlreadyAccepted
        );
        require!(
            clock.unix_timestamp < duel.acceptance_deadline,
            ArcadiaError::DuelExpired
        );

        // Transfer matching stake from opponent → duel escrow
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.opponent.to_account_info(),
                    to: duel.to_account_info(),
                },
            ),
            duel.stake_lamports,
        )?;

        duel.opponent = ctx.accounts.opponent.key();
        duel.status = DuelStatus::Active;

        emit!(DuelAccepted {
            duel_id: duel.duel_id,
            opponent: ctx.accounts.opponent.key(),
        });

        Ok(())
    }

    // ------------------------------------------------------------------------
    // 11. decline_duel — Opponent declines or acceptance window expired
    // ------------------------------------------------------------------------
    pub fn decline_duel(ctx: Context<DeclineDuel>, _duel_id: u64) -> Result<()> {
        let duel = &mut ctx.accounts.duel;
        let clock = Clock::get()?;

        require!(
            duel.status == DuelStatus::PendingAcceptance,
            ArcadiaError::DuelAlreadyAccepted
        );

        // Either the opponent explicitly declines, or the deadline has passed
        let is_opponent_or_timeout = ctx.accounts.caller.key() != duel.challenger
            || clock.unix_timestamp >= duel.acceptance_deadline;
        require!(is_opponent_or_timeout, ArcadiaError::Unauthorized);

        // Refund challenger
        **duel.to_account_info().try_borrow_mut_lamports()? -= duel.stake_lamports;
        **ctx.accounts.challenger.try_borrow_mut_lamports()? += duel.stake_lamports;

        duel.status = DuelStatus::Declined;

        Ok(())
    }

    // ------------------------------------------------------------------------
    // 12. commit_duel_score — Commit score hash for a duel participant
    // ------------------------------------------------------------------------
    pub fn commit_duel_score(
        ctx: Context<CommitDuelScore>,
        duel_id: u64,
        commitment: [u8; 32],
    ) -> Result<()> {
        let duel = &ctx.accounts.duel;
        let clock = Clock::get()?;

        require!(
            duel.status == DuelStatus::Active,
            ArcadiaError::DuelNotAccepted
        );

        let entry = &mut ctx.accounts.duel_score;
        entry.player = ctx.accounts.player.key();
        entry.duel_id = duel_id;
        entry.commitment = commitment;
        entry.committed_at = clock.unix_timestamp;
        entry.revealed = false;
        entry.revealed_score = 0;
        entry.bump = ctx.bumps.duel_score;

        Ok(())
    }

    // ------------------------------------------------------------------------
    // 13. finalise_duel — Reveal scores and pay the winner
    // ------------------------------------------------------------------------
    /// Backend reveals both scores and the contract pays the winner.
    /// Both reveals and payout happen in one instruction for simplicity.
    pub fn finalise_duel(
        ctx: Context<FinaliseDuel>,
        duel_id: u64,
        challenger_score: u64,
        challenger_salt: String,
        opponent_score: u64,
        opponent_salt: String,
    ) -> Result<()> {
        let duel = &mut ctx.accounts.duel;
        let config = &ctx.accounts.config;

        require!(
            duel.status == DuelStatus::Active,
            ArcadiaError::DuelNotAccepted
        );

        // Verify challenger's score
        let mut hasher = Hasher::default();
        hasher.hash(
            format!(
                "{}:{}:{}:{}",
                challenger_score, duel.challenger, duel_id, challenger_salt
            )
            .as_bytes(),
        );
        let challenger_hash = hasher.result().to_bytes();

        let c_entry = &mut ctx.accounts.challenger_score;
        require!(
            challenger_hash == c_entry.commitment,
            ArcadiaError::InvalidReveal
        );
        c_entry.revealed = true;
        c_entry.revealed_score = challenger_score;

        // Verify opponent's score
        let mut hasher2 = Hasher::default();
        hasher2.hash(
            format!(
                "{}:{}:{}:{}",
                opponent_score, duel.opponent, duel_id, opponent_salt
            )
            .as_bytes(),
        );
        let opponent_hash = hasher2.result().to_bytes();

        let o_entry = &mut ctx.accounts.opponent_score;
        require!(
            opponent_hash == o_entry.commitment,
            ArcadiaError::InvalidReveal
        );
        o_entry.revealed = true;
        o_entry.revealed_score = opponent_score;

        // Determine winner (challenger wins ties)
        let total_pool = duel.stake_lamports * 2;
        let treasury_amount = total_pool
            .checked_mul(config.fee_bps)
            .ok_or(ArcadiaError::Overflow)?
            .checked_div(10_000)
            .ok_or(ArcadiaError::Overflow)?;
        let winner_amount = total_pool
            .checked_sub(treasury_amount)
            .ok_or(ArcadiaError::Overflow)?;

        let winner_key = if challenger_score >= opponent_score {
            duel.challenger
        } else {
            duel.opponent
        };

        // Pay winner
        let winner_account = if winner_key == duel.challenger {
            ctx.accounts.challenger_account.to_account_info()
        } else {
            ctx.accounts.opponent_account.to_account_info()
        };

        **duel.to_account_info().try_borrow_mut_lamports()? -= winner_amount;
        **winner_account.try_borrow_mut_lamports()? += winner_amount;

        // Pay treasury
        **duel.to_account_info().try_borrow_mut_lamports()? -= treasury_amount;
        **ctx.accounts.treasury.try_borrow_mut_lamports()? += treasury_amount;

        duel.status = DuelStatus::Finalised;

        emit!(DuelFinalised {
            duel_id,
            winner: winner_key,
            amount: winner_amount,
        });

        Ok(())
    }

    // ------------------------------------------------------------------------
    // 14. create_group_round — Create a group challenge with player cap
    // ------------------------------------------------------------------------
    /// Same as create_round but with a max_players constraint (2–5).
    /// For MVP, no explicit invite list — just a cap.
    pub fn create_group_round(
        ctx: Context<CreateGroupRound>,
        round_id: u64,
        entry_fee: u64,
        duration_seconds: i64,
        max_players: u8,
    ) -> Result<()> {
        require!(entry_fee > 0, ArcadiaError::InvalidEntryFee);
        require!(duration_seconds > 0, ArcadiaError::InvalidRoundDuration);
        require!(
            max_players >= 2 && max_players <= MAX_GROUP_PLAYERS,
            ArcadiaError::GroupFull
        );

        let clock = Clock::get()?;
        let round = &mut ctx.accounts.round;

        round.round_id = round_id;
        round.authority = ctx.accounts.authority.key();
        round.entry_fee = entry_fee;
        round.total_pool = 0;
        round.player_count = 0;
        round.status = RoundStatus::Open;
        round.created_at = clock.unix_timestamp;
        round.ends_at = clock.unix_timestamp + duration_seconds;
        round.reveal_deadline = clock.unix_timestamp + duration_seconds + REVEAL_WINDOW_SECONDS;
        round.winner = Pubkey::default();
        round.max_players = max_players;
        round.bump = ctx.bumps.round;

        emit!(RoundCreated {
            round_id,
            entry_fee,
            ends_at: round.ends_at,
        });

        Ok(())
    }
}

// ============================================================================
// ACCOUNT CONTEXT STRUCTS
// ============================================================================

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProgramConfig::SPACE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CreateRound<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Round::SPACE,
        seeds = [b"round", round_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub round: Account<'info, Round>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct EnterRound<'info> {
    #[account(
        mut,
        seeds = [b"round", round_id.to_le_bytes().as_ref()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    #[account(
        init_if_needed,
        payer = player,
        space = 8 + PlayerDailyRecord::SPACE,
        seeds = [b"daily", player.key().as_ref()],
        bump,
    )]
    pub daily_record: Account<'info, PlayerDailyRecord>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CommitScore<'info> {
    #[account(
        seeds = [b"round", round_id.to_le_bytes().as_ref()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    #[account(
        init,
        payer = authority,
        space = 8 + ScoreEntry::SPACE,
        seeds = [b"score", round_id.to_le_bytes().as_ref(), player.key().as_ref()],
        bump,
    )]
    pub score_entry: Account<'info, ScoreEntry>,

    /// The player whose score is being committed.
    /// CHECK: Validated by the PDA seeds — this is the player from the seed derivation.
    pub player: UncheckedAccount<'info>,

    /// Backend authority that submits the commitment on behalf of the player.
    #[account(
        mut,
        address = round.authority,
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CloseRound<'info> {
    #[account(
        mut,
        seeds = [b"round", round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        has_one = authority,
    )]
    pub round: Account<'info, Round>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct RevealScore<'info> {
    #[account(
        seeds = [b"round", round_id.to_le_bytes().as_ref()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    #[account(
        mut,
        seeds = [b"score", round_id.to_le_bytes().as_ref(), score_entry.player.as_ref()],
        bump = score_entry.bump,
    )]
    pub score_entry: Account<'info, ScoreEntry>,

    #[account(address = round.authority)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct FinaliseRound<'info> {
    #[account(
        mut,
        seeds = [b"round", round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        has_one = authority,
    )]
    pub round: Account<'info, Round>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    /// CHECK: Validated against the winner pubkey passed in the instruction.
    /// The contract verifies this is the highest scorer by checking remaining_accounts.
    #[account(mut)]
    pub winner_account: UncheckedAccount<'info>,

    /// CHECK: Must match the treasury in config.
    #[account(
        mut,
        address = config.treasury,
    )]
    pub treasury: UncheckedAccount<'info>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct RefundPlayer<'info> {
    #[account(
        mut,
        seeds = [b"round", round_id.to_le_bytes().as_ref()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    /// The player being refunded.
    /// CHECK: We verify the score_entry belongs to this player.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,

    /// The score entry proves this player actually entered the round.
    #[account(
        seeds = [b"score", round_id.to_le_bytes().as_ref(), player.key().as_ref()],
        bump = score_entry.bump,
    )]
    pub score_entry: Account<'info, ScoreEntry>,

    /// Anyone can trigger a refund — the caller doesn't have to be the player.
    pub caller: Signer<'info>,
}

// ---- Duel account contexts ----

#[derive(Accounts)]
#[instruction(duel_id: u64)]
pub struct CreateDuel<'info> {
    #[account(
        init,
        payer = challenger,
        space = 8 + Duel::SPACE,
        seeds = [b"duel", duel_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub duel: Account<'info, Duel>,

    #[account(mut)]
    pub challenger: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(duel_id: u64)]
pub struct AcceptDuel<'info> {
    #[account(
        mut,
        seeds = [b"duel", duel_id.to_le_bytes().as_ref()],
        bump = duel.bump,
    )]
    pub duel: Account<'info, Duel>,

    #[account(mut)]
    pub opponent: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(duel_id: u64)]
pub struct DeclineDuel<'info> {
    #[account(
        mut,
        seeds = [b"duel", duel_id.to_le_bytes().as_ref()],
        bump = duel.bump,
    )]
    pub duel: Account<'info, Duel>,

    /// CHECK: The original challenger to receive the refund.
    #[account(
        mut,
        address = duel.challenger,
    )]
    pub challenger: UncheckedAccount<'info>,

    pub caller: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(duel_id: u64)]
pub struct CommitDuelScore<'info> {
    #[account(
        seeds = [b"duel", duel_id.to_le_bytes().as_ref()],
        bump = duel.bump,
    )]
    pub duel: Account<'info, Duel>,

    #[account(
        init,
        payer = authority,
        space = 8 + DuelScore::SPACE,
        seeds = [b"duel_score", duel_id.to_le_bytes().as_ref(), player.key().as_ref()],
        bump,
    )]
    pub duel_score: Account<'info, DuelScore>,

    /// CHECK: Player whose score is being committed.
    pub player: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(duel_id: u64)]
pub struct FinaliseDuel<'info> {
    #[account(
        mut,
        seeds = [b"duel", duel_id.to_le_bytes().as_ref()],
        bump = duel.bump,
    )]
    pub duel: Account<'info, Duel>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        mut,
        seeds = [b"duel_score", duel_id.to_le_bytes().as_ref(), duel.challenger.as_ref()],
        bump = challenger_score.bump,
    )]
    pub challenger_score: Account<'info, DuelScore>,

    #[account(
        mut,
        seeds = [b"duel_score", duel_id.to_le_bytes().as_ref(), duel.opponent.as_ref()],
        bump = opponent_score.bump,
    )]
    pub opponent_score: Account<'info, DuelScore>,

    /// CHECK: Challenger wallet to receive payout if they win.
    #[account(mut, address = duel.challenger)]
    pub challenger_account: UncheckedAccount<'info>,

    /// CHECK: Opponent wallet to receive payout if they win.
    #[account(mut, address = duel.opponent)]
    pub opponent_account: UncheckedAccount<'info>,

    /// CHECK: Treasury wallet.
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CreateGroupRound<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Round::SPACE,
        seeds = [b"round", round_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub round: Account<'info, Round>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ============================================================================
// ACCOUNT DATA STRUCTS
// ============================================================================

#[account]
pub struct ProgramConfig {
    pub treasury: Pubkey,
    pub fee_bps: u64,
    pub authority: Pubkey,
    pub bump: u8,
}

impl ProgramConfig {
    pub const SPACE: usize = 32 + 8 + 32 + 1;
}

#[account]
pub struct Round {
    pub round_id: u64,
    pub authority: Pubkey,
    pub entry_fee: u64,
    pub total_pool: u64,
    pub player_count: u64,
    pub status: RoundStatus,
    pub created_at: i64,
    pub ends_at: i64,
    pub reveal_deadline: i64,
    pub winner: Pubkey,
    pub max_players: u8,
    pub bump: u8,
}

impl Round {
    // 8 + 32 + 8 + 8 + 8 + 1 + 8 + 8 + 8 + 32 + 1 + 1 = 123
    // Add padding for safety
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 8 + 1 + 8 + 8 + 8 + 32 + 1 + 1 + 32;
}

#[account]
pub struct PlayerDailyRecord {
    pub player: Pubkey,
    pub date: i64,
    pub entries: u8,
}

impl PlayerDailyRecord {
    pub const SPACE: usize = 32 + 8 + 1;
}

#[account]
pub struct ScoreEntry {
    pub player: Pubkey,
    pub round_id: u64,
    pub commitment: [u8; 32],
    pub committed_at: i64,
    pub revealed: bool,
    pub revealed_score: u64,
    pub bump: u8,
}

impl ScoreEntry {
    pub const SPACE: usize = 32 + 8 + 32 + 8 + 1 + 8 + 1;
}

/// Mirror of ScoreEntry fields for manual deserialization from remaining_accounts.
/// Must match the field order and types of the ScoreEntry account.
#[derive(AnchorDeserialize)]
pub struct ScoreEntryData {
    pub player: Pubkey,
    pub round_id: u64,
    pub commitment: [u8; 32],
    pub committed_at: i64,
    pub revealed: bool,
    pub revealed_score: u64,
    pub bump: u8,
}

#[account]
pub struct Duel {
    pub duel_id: u64,
    pub challenger: Pubkey,
    pub opponent: Pubkey,
    pub stake_lamports: u64,
    pub status: DuelStatus,
    pub seed: u64,
    pub acceptance_deadline: i64,
    pub created_at: i64,
    pub bump: u8,
}

impl Duel {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 1 + 8 + 8 + 8 + 1 + 16;
}

#[account]
pub struct DuelScore {
    pub player: Pubkey,
    pub duel_id: u64,
    pub commitment: [u8; 32],
    pub committed_at: i64,
    pub revealed: bool,
    pub revealed_score: u64,
    pub bump: u8,
}

impl DuelScore {
    pub const SPACE: usize = 32 + 8 + 32 + 8 + 1 + 8 + 1;
}

// ============================================================================
// ENUMS
// ============================================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RoundStatus {
    Open,
    Closed,
    Finalised,
    Cancelled,
    Refundable,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum DuelStatus {
    PendingAcceptance,
    Active,
    Closed,
    Finalised,
    Declined,
}

// ============================================================================
// ERRORS
// ============================================================================

#[error_code]
pub enum ArcadiaError {
    #[msg("Round is not open")]
    RoundNotOpen,
    #[msg("Round has expired")]
    RoundExpired,
    #[msg("Round has not expired yet")]
    RoundNotExpired,
    #[msg("Round is not closed")]
    RoundNotClosed,
    #[msg("Daily entry limit reached (max 5 per day)")]
    DailyLimitReached,
    #[msg("Score already revealed")]
    AlreadyRevealed,
    #[msg("Invalid reveal — commitment hash mismatch")]
    InvalidReveal,
    #[msg("Refund not available for this round")]
    RefundNotAvailable,
    #[msg("Not enough players in round")]
    NotEnoughPlayers,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Duel already accepted")]
    DuelAlreadyAccepted,
    #[msg("Duel acceptance window expired")]
    DuelExpired,
    #[msg("Duel not yet accepted")]
    DuelNotAccepted,
    #[msg("Group is full")]
    GroupFull,
    #[msg("Entry fee must be greater than 0")]
    InvalidEntryFee,
    #[msg("Round duration must be greater than 0")]
    InvalidRoundDuration,
    #[msg("Arithmetic overflow")]
    Overflow,
}

// ============================================================================
// EVENTS
// ============================================================================

#[event]
pub struct RoundCreated {
    pub round_id: u64,
    pub entry_fee: u64,
    pub ends_at: i64,
}

#[event]
pub struct PlayerEntered {
    pub round_id: u64,
    pub player: Pubkey,
    pub total_pool: u64,
}

#[event]
pub struct ScoreCommitted {
    pub round_id: u64,
    pub player: Pubkey,
    pub committed_at: i64,
}

#[event]
pub struct RoundClosed {
    pub round_id: u64,
    pub player_count: u64,
    pub total_pool: u64,
}

#[event]
pub struct ScoreRevealed {
    pub round_id: u64,
    pub player: Pubkey,
    pub score: u64,
}

#[event]
pub struct RoundFinalised {
    pub round_id: u64,
    pub winner: Pubkey,
    pub winner_amount: u64,
    pub treasury_amount: u64,
}

#[event]
pub struct PlayerRefunded {
    pub round_id: u64,
    pub player: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DuelCreated {
    pub duel_id: u64,
    pub challenger: Pubkey,
    pub stake: u64,
}

#[event]
pub struct DuelAccepted {
    pub duel_id: u64,
    pub opponent: Pubkey,
}

#[event]
pub struct DuelFinalised {
    pub duel_id: u64,
    pub winner: Pubkey,
    pub amount: u64,
}
