use std::convert::TryInto;

use anchor_lang::{prelude::*, system_program};
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use vipers::prelude::*;

const ADMIN_FEE_BPS: u64 = 100;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod pawn_shop {
    use super::*;

    pub fn create_loan(
        ctx: Context<CreateLoan>,
        amount: u64,
        desired_terms: Option<LoanTerms>,
    ) -> Result<()> {
        let pawn_loan = &mut ctx.accounts.pawn_loan;

        pawn_loan.bump = unwrap_bump!(ctx, "pawn_token_account");
        pawn_loan.status = LoanStatus::Created;
        pawn_loan.borrower = ctx.accounts.borrower.key();
        pawn_loan.pawn_token_account = ctx.accounts.pawn_token_account.key();
        pawn_loan.desired_terms = desired_terms;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.borrower_token_account.to_account_info(),
                    to: ctx.accounts.pawn_token_account.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            amount,
        )?;

        Ok(())
    }

    pub fn begin_loan(
        ctx: Context<BeginLoan>,
    ) -> Result<()> {
        let unix_timestamp = Clock::get()?.unix_timestamp;
        let pawn_loan = &mut ctx.accounts.pawn_loan;

        invariant!(pawn_loan.status == LoanStatus::Created, InvalidLoanStatus);

        let terms = ctx.accounts.offer.terms.clone();
        pawn_loan.status = LoanStatus::Ongoing;
        pawn_loan.start_time = unix_timestamp;
        pawn_loan.lender = ctx.accounts.offer.lender.key();
        let principal_amount = terms.principal_amount;
        pawn_loan.terms = Some(terms);

        let offer_account_info = ctx.accounts.offer.to_account_info();
        let borrower_account_info = ctx.accounts.borrower.to_account_info();

        **offer_account_info.lamports.borrow_mut() = unwrap_int!(offer_account_info
            .lamports()
            .checked_sub(principal_amount));
        **borrower_account_info.lamports.borrow_mut() = unwrap_int!(borrower_account_info
            .lamports()
            .checked_add(principal_amount));

        Ok(())
    }

    pub fn underwrite_loan(
        ctx: Context<UnderwriteLoan>,
    ) -> Result<()> {
        let unix_timestamp = Clock::get()?.unix_timestamp;
        let pawn_loan = &mut ctx.accounts.pawn_loan;

        invariant!(pawn_loan.status == LoanStatus::Created, InvalidLoanStatus);

        let terms = unwrap_opt!(pawn_loan.desired_terms.clone());
        pawn_loan.status = LoanStatus::Ongoing;
        pawn_loan.start_time = unix_timestamp;
        pawn_loan.lender = ctx.accounts.lender.key();
        let principal_amount = terms.principal_amount;
        pawn_loan.terms = Some(terms);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.lender.to_account_info(),
                    to: ctx.accounts.borrower.to_account_info(),
                },
            ),
            principal_amount,
        )?;

        Ok(())
    }

    pub fn create_offer(ctx: Context<CreateOffer>, terms: LoanTerms) -> Result<()> {
        let offer = &mut ctx.accounts.offer;
        let pawn_loan = &ctx.accounts.pawn_loan;

        invariant!(pawn_loan.status == LoanStatus::Created, InvalidLoanStatus);

        offer.bump = unwrap_bump!(ctx, "offer");
        offer.lender = ctx.accounts.lender.key();
        offer.terms = terms.clone();

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.lender.to_account_info(),
                    to: ctx.accounts.offer.to_account_info(),
                },
            ),
            terms.principal_amount,
        )?;

        Ok(())
    }

    pub fn repay_loan(ctx: Context<RepayLoan>) -> Result<()> {
        let unix_timestamp = Clock::get()?.unix_timestamp;
        let pawn_loan = &mut ctx.accounts.pawn_loan;

        invariant!(pawn_loan.status == LoanStatus::Ongoing, InvalidLoanStatus);

        pawn_loan.status = LoanStatus::Repaid;

        let terms = unwrap_opt!(pawn_loan.terms.clone());
        let interest_due = compute_interest_due(&terms, pawn_loan.start_time, unix_timestamp)?;
        let admin_fee = interest_due * ADMIN_FEE_BPS / 10_000;
        let payoff_amount = terms.principal_amount + interest_due - admin_fee;

        // Transfer principal plus interest to lender
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.borrower.to_account_info(),
                    to: ctx.accounts.lender.to_account_info(),
                },
            ),
            payoff_amount,
        )?;

        // Transfer fees
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.borrower.to_account_info(),
                    to: ctx.accounts.admin.to_account_info(),
                },
            ),
            admin_fee,
        )?;

        // Get the collateral back
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.pawn_token_account.to_account_info(),
                    to: ctx.accounts.borrower_token_account.to_account_info(),
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
        let loan = &mut ctx.accounts.pawn_loan;

        invariant!(loan.status == LoanStatus::Created, InvalidLoanStatus);
        loan.status = LoanStatus::Cancelled;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.pawn_token_account.to_account_info(),
                    to: ctx.accounts.borrower_token_account.to_account_info(),
                    authority: ctx.accounts.pawn_token_account.to_account_info(),
                },
                &[&[
                    b"pawn-token-account",
                    loan.key().as_ref(),
                    &[loan.bump],
                ]],
            ),
            ctx.accounts.pawn_token_account.amount,
        )?;

        Ok(())
    }

    pub fn close_offer(_ctx: Context<CloseOffer>) -> Result<()> {
        Ok(())
    }

    pub fn seize_nft(ctx: Context<SeizeNft>) -> Result<()> {
        let unix_timestamp = Clock::get()?.unix_timestamp;
        let pawn_loan = &mut ctx.accounts.pawn_loan;

        invariant!(pawn_loan.status == LoanStatus::Ongoing, InvalidLoanStatus);

        let terms = unwrap_opt!(pawn_loan.terms.clone());
        let end_time = unwrap_int!(pawn_loan.start_time.checked_add(terms.duration));
        invariant!(end_time < unix_timestamp, CannotSeizeBeforeExpiry);
        pawn_loan.status = LoanStatus::Defaulted;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.pawn_token_account.to_account_info(),
                    to: ctx.accounts.lender_token_account.to_account_info(),
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
    #[account(mut)]
    pub borrower_token_account: Account<'info, TokenAccount>,
    #[account(init, seeds = [b"pawn-token-account", pawn_loan.key().as_ref()], bump, payer = borrower, token::mint = mint, token::authority = pawn_token_account)]
    pub pawn_token_account: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BeginLoan<'info> {
    #[account(mut, has_one = borrower)]
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(has_one = pawn_loan)]
    pub offer: Account<'info, Offer>,
}

#[derive(Accounts)]
pub struct UnderwriteLoan<'info> {
    #[account(mut, has_one = borrower)]
    pub pawn_loan: Account<'info, PawnLoan>,
    /// CHECK: Receives the principal and can be of any nature
    #[account(mut)]
    pub borrower: UncheckedAccount<'info>,
    #[account(mut)]
    pub lender: Signer<'info>,
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
    #[account(mut, has_one = borrower, has_one = pawn_token_account, has_one = lender)]
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub pawn_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(mut)]
    pub borrower_token_account: Account<'info, TokenAccount>,
    /// CHECK: Receives the repayment, its nature does not matter
    #[account(mut)]
    pub lender: UncheckedAccount<'info>,
    /// CHECK: Receives admin fee, address is unique per program
    #[account(mut, seeds = [b"admin"], bump)] // Fees are parked into a PDA for now
    pub admin: UncheckedAccount<'info>,
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
    pub borrower_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SeizeNft<'info> {
    #[account(mut, has_one = lender, has_one = pawn_token_account)]
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub pawn_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(mut)]
    pub lender_token_account: Account<'info, TokenAccount>,
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
    Created,
    Ongoing,
    Repaid,
    Defaulted,
    Cancelled,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct LoanTerms {
    pub principal_amount: u64,
    pub interest_rate_for_duration_bps: u64,
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
    pub start_time: i64,
}

#[account]
pub struct Offer {
    pub bump: u8,
    pub pawn_loan: Pubkey,
    pub lender: Pubkey,
    pub terms: LoanTerms,
}

// TODO: do checked math
pub fn compute_interest_due(terms: &LoanTerms, start_time: i64, timestamp: i64) -> Result<u64> {
    let interest_due_after_entire_duration = terms.principal_amount as u128
        * terms.interest_rate_for_duration_bps as u128 / 10_000;
    
    let elapsed_time = unwrap_int!(timestamp.checked_sub(start_time));

    let interest_due_after_elapsed_duration = interest_due_after_entire_duration
        * elapsed_time as u128 / terms.duration as u128;

    interest_due_after_elapsed_duration.try_into().map_err(|_| error!(ErrorCode::CalculationError))
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
            interest_rate_for_duration_bps: 3500, // 35%
            duration: 7 * 24 * 60 * 60, // 7 days
        };
        // Entire duration
        assert_eq!(1_750_000_000, compute_interest_due(&terms, 123456789, 123456789 + terms.duration).unwrap());

        // Half duration
        assert_eq!(875_000_000, compute_interest_due(&terms, 123456789, 123456789 + terms.duration / 2).unwrap());
    }
}