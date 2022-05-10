use std::{convert::TryInto, cmp};

use anchor_lang::{prelude::*, system_program};
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use vipers::prelude::*;

const ADMIN_FEE_BPS: u64 = 200;
const SECONDS_PER_YEAR: u32 = 31_536_000;
const MINIMUM_PERIOD_RATIO_BPS: i64 = 2_500;

mod native_mint {
    use super::*;
    declare_id!("So11111111111111111111111111111111111111112");
}

#[cfg(feature = "devnet")]
declare_id!("C3yujyu2LMpsKisZN8CkV86SpeYVDbd1P7nU2UhpfocA");

#[cfg(not(feature = "devnet"))]
declare_id!("PawnShop11111111111111111111111111111111112");

#[program]
pub mod pawn_shop {
    use super::*;

    pub fn create_loan(
        ctx: Context<CreateLoan>,
        amount: u64,
        desired_terms: Option<LoanTerms>,
    ) -> Result<()> {
        let unix_timestamp = Clock::get()?.unix_timestamp;
        let pawn_loan = &mut ctx.accounts.pawn_loan;

        pawn_loan.bump = unwrap_bump!(ctx, "pawn_token_account");
        pawn_loan.status = LoanStatus::Open;
        pawn_loan.borrower = ctx.accounts.borrower.key();
        pawn_loan.pawn_token_account = ctx.accounts.pawn_token_account.key();
        pawn_loan.desired_terms = desired_terms;
        pawn_loan.creation_time = unix_timestamp;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.borrower_pawn_token_account.to_account_info(),
                    to: ctx.accounts.pawn_token_account.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            amount,
        )?;

        Ok(())
    }

    pub fn underwrite_loan(ctx: Context<UnderwriteLoan>) -> Result<()> {
        let unix_timestamp = Clock::get()?.unix_timestamp;
        let pawn_loan = &mut ctx.accounts.pawn_loan;

        invariant!(pawn_loan.status == LoanStatus::Open, InvalidLoanStatus);

        let terms = unwrap_opt!(pawn_loan.desired_terms.clone());
        pawn_loan.status = LoanStatus::Active;
        pawn_loan.start_time = unix_timestamp;
        pawn_loan.lender = ctx.accounts.lender.key();
        let principal_amount = terms.principal_amount;
        let loan_mint = terms.mint;
        pawn_loan.terms = Some(terms);

        if loan_mint == native_mint::ID {
            assert_keys_eq!(pawn_loan.borrower, ctx.accounts.borrower_payment_account);

            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.lender_payment_account.to_account_info(),
                        to: ctx.accounts.borrower_payment_account.to_account_info(),
                    },
                ),
                principal_amount,
            )?;
        } else {
            let borrower_payment_token_account: Account<TokenAccount> =
                Account::try_from(&ctx.accounts.borrower_payment_account)?;
            assert_eq!(pawn_loan.borrower, borrower_payment_token_account.owner);

            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: ctx.accounts.lender_payment_account.to_account_info(),
                        to: ctx.accounts.borrower_payment_account.to_account_info(),
                        authority: ctx.accounts.lender.to_account_info(),
                    },
                ),
                principal_amount,
            )?;
        }

        Ok(())
    }

    // Disable for now as not required
    // pub fn create_offer(ctx: Context<CreateOffer>, terms: LoanTerms) -> Result<()> {
    //     Ok(())
    // }
    // pub fn begin_loan(ctx: Context<BeginLoan>) -> Result<()> {
    //     Ok(())
    // }

    pub fn repay_loan(ctx: Context<RepayLoan>) -> Result<()> {
        let unix_timestamp = Clock::get()?.unix_timestamp;
        let pawn_loan = &mut ctx.accounts.pawn_loan;

        invariant!(pawn_loan.status == LoanStatus::Active, InvalidLoanStatus);

        pawn_loan.status = LoanStatus::Repaid;

        let terms = unwrap_opt!(pawn_loan.terms.clone());
        let interest_due = compute_interest_due(&terms, pawn_loan.start_time, unix_timestamp)?;
        let admin_fee = interest_due * ADMIN_FEE_BPS / 10_000;
        let payoff_amount = terms.principal_amount + interest_due - admin_fee;
        pawn_loan.end_time = unix_timestamp;

        // Transfer payoff to lender and admin fee
        if terms.mint == native_mint::ID {
            assert_keys_eq!(pawn_loan.lender, ctx.accounts.lender_payment_account);

            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.borrower_payment_account.to_account_info(),
                        to: ctx.accounts.lender_payment_account.to_account_info(),
                    },
                ),
                payoff_amount,
            )?;

            assert_keys_eq!(ctx.accounts.admin, ctx.accounts.admin_payment_account);

            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.borrower_payment_account.to_account_info(),
                        to: ctx.accounts.admin_payment_account.to_account_info(),
                    },
                ),
                admin_fee,
            )?;
        } else {
            let lender_payment_token_account: Account<TokenAccount> =
                Account::try_from(&ctx.accounts.lender_payment_account)?;
            assert_keys_eq!(pawn_loan.lender, lender_payment_token_account.owner);

            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: ctx.accounts.borrower_payment_account.to_account_info(),
                        to: ctx.accounts.lender_payment_account.to_account_info(),
                        authority: ctx.accounts.borrower.to_account_info(),
                    },
                ),
                payoff_amount,
            )?;

            let admin_payment_token_account: Account<TokenAccount> =
                Account::try_from(&ctx.accounts.admin_payment_account)?;
            assert_keys_eq!(ctx.accounts.admin, admin_payment_token_account.owner);

            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: ctx.accounts.borrower_payment_account.to_account_info(),
                        to: ctx.accounts.admin_payment_account.to_account_info(),
                        authority: ctx.accounts.borrower.to_account_info(),
                    },
                ),
                admin_fee,
            )?;
        }

        // Get the collateral back
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.pawn_token_account.to_account_info(),
                    to: ctx.accounts.borrower_pawn_token_account.to_account_info(),
                    authority: ctx.accounts.pawn_token_account.to_account_info(),
                },
                &[&[
                    b"pawn-token-account",
                    pawn_loan.key().as_ref(),
                    &[pawn_loan.bump],
                ]],
            ),
            ctx.accounts.pawn_token_account.amount,
        )?;

        Ok(())
    }

    pub fn cancel_loan(ctx: Context<CancelLoan>) -> Result<()> {
        let unix_timestamp = Clock::get()?.unix_timestamp;
        let pawn_loan = &mut ctx.accounts.pawn_loan;

        invariant!(pawn_loan.status == LoanStatus::Open, InvalidLoanStatus);
        pawn_loan.status = LoanStatus::Cancelled;
        pawn_loan.end_time = unix_timestamp;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.pawn_token_account.to_account_info(),
                    to: ctx.accounts.borrower_pawn_token_account.to_account_info(),
                    authority: ctx.accounts.pawn_token_account.to_account_info(),
                },
                &[&[
                    b"pawn-token-account",
                    pawn_loan.key().as_ref(),
                    &[pawn_loan.bump],
                ]],
            ),
            ctx.accounts.pawn_token_account.amount,
        )?;

        Ok(())
    }

    pub fn close_offer(_ctx: Context<CloseOffer>) -> Result<()> {
        Ok(())
    }

    pub fn seize_pawn(ctx: Context<SeizePawn>) -> Result<()> {
        let unix_timestamp = Clock::get()?.unix_timestamp;
        let pawn_loan = &mut ctx.accounts.pawn_loan;

        invariant!(pawn_loan.status == LoanStatus::Active, InvalidLoanStatus);

        let terms = unwrap_opt!(pawn_loan.terms.clone());
        let overdue_time = unwrap_int!(pawn_loan.start_time.checked_add(terms.duration));
        invariant!(overdue_time < unix_timestamp, CannotSeizeBeforeExpiry);
        pawn_loan.status = LoanStatus::Defaulted;
        pawn_loan.end_time = unix_timestamp;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.pawn_token_account.to_account_info(),
                    to: ctx.accounts.lender_pawn_token_account.to_account_info(),
                    authority: ctx.accounts.pawn_token_account.to_account_info(),
                },
                &[&[
                    b"pawn-token-account",
                    pawn_loan.key().as_ref(),
                    &[pawn_loan.bump],
                ]],
            ),
            ctx.accounts.pawn_token_account.amount,
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateLoan<'info> {
    #[account(init, payer = borrower, space = 300)]
    // TODO: Calculate space properly
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(init, seeds = [b"pawn-token-account", pawn_loan.key().as_ref()], bump, payer = borrower, token::mint = pawn_mint, token::authority = pawn_token_account)]
    pub pawn_token_account: Account<'info, TokenAccount>,
    pub pawn_mint: Account<'info, Mint>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(mut)]
    pub borrower_pawn_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BeginLoan<'info> {
    #[account(mut, has_one = borrower)]
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(has_one = pawn_loan)]
    pub offer: Account<'info, Offer>,
    #[account(mut)]
    pub borrower: Signer<'info>,
}

#[derive(Accounts)]
pub struct UnderwriteLoan<'info> {
    #[account(mut)]
    pub pawn_loan: Account<'info, PawnLoan>,
    pub lender: Signer<'info>,
    /// CHECK: Sends the principal, can be the lender wallet or his spl token account
    #[account(mut)]
    pub lender_payment_account: UncheckedAccount<'info>,
    /// CHECK: Receives the principal, can be the borrower wallet or his spl token account
    #[account(mut)]
    pub borrower_payment_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(terms: LoanTerms)]
pub struct CreateOffer<'info> {
    #[account(
        init,
        seeds = [b"offer", pawn_loan.key().as_ref(), lender.key().as_ref(), &terms.try_to_vec().unwrap()],
        bump,
        space = 300, // TODO: Calculate space
        payer = lender)]
    pub offer: Account<'info, Offer>,
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub lender: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RepayLoan<'info> {
    #[account(mut, has_one = borrower, has_one = pawn_token_account)]
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub pawn_token_account: Account<'info, TokenAccount>,
    pub borrower: Signer<'info>,
    /// CHECK: Sends the payoff, can be the borrower wallet or his spl token account
    #[account(mut)]
    pub borrower_payment_account: UncheckedAccount<'info>,
    #[account(mut)]
    pub borrower_pawn_token_account: Account<'info, TokenAccount>,
    /// CHECK: Receives the payoff, can be the borrower wallet or his spl token account
    #[account(mut)]
    pub lender_payment_account: UncheckedAccount<'info>,
    #[account(seeds = [b"admin"], bump)]
    pub admin: SystemAccount<'info>,
    /// CHECK: Receives admin fee, can be the admin pda or a spl token account owned by the admin pda
    #[account(mut)]
    pub admin_payment_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelLoan<'info> {
    #[account(mut, has_one = borrower, has_one = pawn_token_account)]
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub pawn_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(mut)]
    pub borrower_pawn_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SeizePawn<'info> {
    #[account(mut, has_one = lender, has_one = pawn_token_account)]
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub pawn_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(mut)]
    pub lender_pawn_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseOffer<'info> {
    #[account(mut, has_one = lender, close = lender)]
    pub offer: Account<'info, Offer>,
    #[account(mut)]
    pub lender: Signer<'info>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize, PartialEq)]
pub enum LoanStatus {
    Open,
    Active,
    Repaid,
    Defaulted,
    Cancelled,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct LoanTerms {
    pub principal_amount: u64,
    pub mint: Pubkey,
    pub annual_percentage_rate_bps: u64,
    pub duration: i64,
}

#[account]
pub struct PawnLoan {
    pub bump: u8,
    pub borrower: Pubkey,
    pub pawn_token_account: Pubkey,
    pub status: LoanStatus,
    pub lender: Pubkey,
    pub desired_terms: Option<LoanTerms>,
    pub terms: Option<LoanTerms>,
    pub creation_time: i64,
    pub start_time: i64,
    pub end_time: i64,
}

#[account]
pub struct Offer {
    pub bump: u8,
    pub pawn_loan: Pubkey,
    pub offer_payment_account: Pubkey,
    pub lender: Pubkey,
    pub terms: LoanTerms,
    pub creation_time: i64,
}

// TODO: do checked math
pub fn compute_interest_due(terms: &LoanTerms, start_time: i64, timestamp: i64) -> Result<u64> {
    // Elapsed time is at a minimum X% of the total duration in order to floor the minimum interest
    let elapsed_time = unwrap_int!(timestamp.checked_sub(start_time));
    let minimum_interest_duration =
        terms.duration * MINIMUM_PERIOD_RATIO_BPS / 10_000;

    let effective_elapsed_time = cmp::max(elapsed_time, minimum_interest_duration);

    let interest_due = terms.principal_amount as u128
        * terms.annual_percentage_rate_bps as u128
        * effective_elapsed_time as u128
        / SECONDS_PER_YEAR as u128
        / 10_000;

    interest_due
        .try_into()
        .map_err(|_| error!(ErrorCode::CalculationError))
}

#[error_code]
pub enum ErrorCode {
    CalculationError,
    InvalidLoanStatus,
    CannotCancelLoanWithMoreThanZeroBids,
    CannotSeizeBeforeExpiry,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_interest_due_is_correct() {
        let terms = LoanTerms {
            principal_amount: 5_000_000_000,
            mint: Pubkey::default(),
            annual_percentage_rate_bps: 3500, // 35%
            duration: 7 * 24 * 60 * 60,       // 7 days
        };
        // Entire duration
        assert_eq!(
            33_561_643,
            compute_interest_due(&terms, 123456789, 123456789 + terms.duration).unwrap()
        );

        // Half duration
        assert_eq!(
            16_780_821,
            compute_interest_due(&terms, 123456789, 123456789 + terms.duration / 2).unwrap()
        );

        // 10% of the duration should be brought back to 25% of duration as being the minimum chargeable duration
        assert_eq!(
            8_390_410,
            compute_interest_due(&terms, 123456789, 123456789 + terms.duration / 10).unwrap()
        );
    }
}
