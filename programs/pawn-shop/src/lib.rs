use anchor_lang::{prelude::*, system_program};
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use vipers::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod pawn_shop {
    use super::*;

    pub fn create_loan(
        ctx: Context<CreateLoan>,
        amount: u64,
        interest_rate: u64,
        max_loan_amount: u64,
        loan_complete_time: i64,
    ) -> Result<()> {
        let unix_timestamp = Clock::get()?.unix_timestamp;
        let pawn_loan = &mut ctx.accounts.pawn_loan;

        invariant!(loan_complete_time > unix_timestamp, CannotCreateLoanInPast);

        pawn_loan.bump = *ctx.bumps.get("pawn_token_account").unwrap();
        pawn_loan.owner = ctx.accounts.owner.key();
        pawn_loan.pawn_token_account = ctx.accounts.pawn_token_account.key();
        pawn_loan.interest_rate = interest_rate;
        pawn_loan.max_loan_amount = max_loan_amount;
        pawn_loan.loan_complete_time = loan_complete_time;

        // Transfer from
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.owner_token_account.to_account_info(),
                    to: ctx.accounts.pawn_token_account.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        Ok(())
    }

    pub fn underwrite_loan(ctx: Context<UnderwriteLoan>, loan_amount: u64) -> Result<()> {
        let unix_timestamp = Clock::get()?.unix_timestamp;
        let pawn_loan_account_info = ctx.accounts.pawn_loan.clone().to_account_info();
        let loan = &mut ctx.accounts.pawn_loan;

        assert_keys_neq!(loan.owner, Pubkey::default(), CannotUnderwriteARepaidLoan);
        invariant!(
            loan.loan_complete_time >= unix_timestamp,
            CannotUnderwriteExpiredLoan
        );

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.new_lender.to_account_info(),
                    to: pawn_loan_account_info,
                },
            ),
            loan_amount,
        )?;

        if loan.first_bid_time != 0 {
            let total_interest = loan.calculate_total_interest(unix_timestamp, 0);
            let bid_payout = unwrap_int!(loan.loan_amount.checked_add(total_interest));

            invariant!(bid_payout <= loan_amount, CannotUnderwriteLessThanTopLender);
            invariant!(
                loan.max_loan_amount + total_interest >= loan_amount,
                CannotUnderwriteMoreThanMaxLoan
            );

            assert_keys_eq!(loan.lender, ctx.accounts.lender, LenderDoesNotMatch);

            // Buyout current top bidder
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.new_lender.to_account_info(),
                        to: ctx.accounts.lender.to_account_info(),
                    },
                ),
                bid_payout,
            )?;

            // Increment historic paid interest
            loan.historic_interest += total_interest;
            // Update new loan amount
            loan.loan_amount = loan_amount - total_interest;
        } else {
            invariant!(loan.max_loan_amount >= loan_amount, CannotUnderwriteMoreThanMaxLoan);

            loan.first_bid_time = unix_timestamp;
            loan.loan_amount = loan_amount;
        }

        loan.lender = ctx.accounts.new_lender.key();
        loan.last_bid_time = unix_timestamp;

        Ok(())
    }

    pub fn draw_loan(ctx: Context<DrawLoan>) -> Result<()> {
        let loan = &mut ctx.accounts.pawn_loan;
        let available_capital = loan.loan_amount - loan.loan_amount_drawn;

        invariant!(loan.loan_amount_drawn < loan.loan_amount, MaxDrawCapacityReached);

        loan.loan_amount_drawn = loan.loan_amount;

        let pawn_loan_account_info = ctx.accounts.pawn_loan.to_account_info();
        let owner_account_info = ctx.accounts.owner.to_account_info();

        // Draw the maximum available
        **pawn_loan_account_info.lamports.borrow_mut() = unwrap_int!(pawn_loan_account_info
            .lamports()
            .checked_sub(available_capital));
        **owner_account_info.lamports.borrow_mut() = unwrap_int!(owner_account_info
            .lamports()
            .checked_add(available_capital));

        Ok(())
    }

    pub fn repay_loan(ctx: Context<RepayLoan>) -> Result<()> {
        let unix_timestamp = Clock::get()?.unix_timestamp;
        let pawn_loan_account_info = ctx.accounts.pawn_loan.clone().to_account_info();
        let loan = &mut ctx.accounts.pawn_loan;

        invariant!(loan.first_bid_time != 0, CannotRepayLoanWith0Bid);

        // Actually should we allow this? Repay late but still repay
        invariant!(loan.loan_complete_time >= unix_timestamp, CannotRepayExpiredLoan);

        let total_interest = loan.calculate_total_interest(unix_timestamp, 0);
        let total_amount = loan.loan_amount + total_interest;

        // Payout current top bidder
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.lender.to_account_info(),
                },
            ),
            total_amount,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.pawn_token_account.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: pawn_loan_account_info,
                },
                &[&[
                    b"pawn-token-account",
                    loan.key().as_ref(),
                    &[loan.bump],
                ]],
            ),
            ctx.accounts.pawn_token_account.amount,
        )?;

        loan.owner = Pubkey::default();

        Ok(())
    }

    pub fn cancel_loan(ctx: Context<CancelLoan>) -> Result<()> {
        let pawn_loan_account_info = ctx.accounts.pawn_loan.clone().to_account_info();
        let loan = &mut ctx.accounts.pawn_loan;

        invariant!(loan.first_bid_time == 0, CannotCancelLoanWithMoreThanZeroBids);

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.pawn_token_account.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: pawn_loan_account_info,
                },
                &[&[
                    b"pawn-loan",
                    loan.key().as_ref(),
                    &[loan.bump],
                ]],
            ),
            ctx.accounts.pawn_token_account.amount,
        )?;

        loan.owner = Pubkey::default();

        Ok(())
    }

    pub fn seize_nft(ctx: Context<SeizeNft>) -> Result<()> {
        let unix_timestamp = Clock::get()?.unix_timestamp;
        let loan = &ctx.accounts.pawn_loan;

        invariant!(loan.owner != Pubkey::default(), CannotSeizeFromRepaidLoan);
        invariant!(loan.loan_complete_time < unix_timestamp, CannotSeizeBeforeExpiry);

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.pawn_token_account.to_account_info(),
                    to: ctx.accounts.lender.to_account_info(),
                    authority: ctx.accounts.pawn_loan.to_account_info(),
                },
                &[&[
                    b"pawn-loan",
                    loan.key().as_ref(),
                    &[loan.bump],
                ]],
            ),
            ctx.accounts.pawn_token_account.amount,
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateLoan<'info> {
    #[account(init, payer = owner, space = 300)]
    // TODO: Calculate space properly
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,
    #[account(init, seeds = [b"pawn-token-account", pawn_loan.key().as_ref()], bump, payer = owner, token::mint = mint, token::authority = pawn_token_account)]
    pub pawn_token_account: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnderwriteLoan<'info> {
    #[account(mut)]
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub new_lender: Signer<'info>,
    /// CHECK: Validated to be the current lender or the new lender repeated
    #[account(mut)]
    pub lender: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DrawLoan<'info> {
    #[account(mut, has_one = owner)]
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct RepayLoan<'info> {
    #[account(mut, has_one = owner, has_one = pawn_token_account, has_one = lender)]
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub pawn_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,
    /// CHECK: Receives the repayment, its nature does not matter
    #[account(mut)]
    pub lender: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelLoan<'info> {
    #[account(mut, has_one = owner, has_one = pawn_token_account)]
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub pawn_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,
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

#[account]
pub struct PawnLoan {
    pub bump: u8,
    pub owner: Pubkey,
    pub pawn_token_account: Pubkey,
    pub lender: Pubkey,
    pub interest_rate: u64,
    pub loan_amount: u64,
    pub max_loan_amount: u64,
    pub loan_amount_drawn: u64,
    pub first_bid_time: i64,
    pub last_bid_time: i64,
    pub historic_interest: u64,
    pub loan_complete_time: i64,
}

impl PawnLoan {
    fn calculate_total_interest(&self, timestamp: i64, future: i64) -> u64 {
        self.historic_interest + self.calculate_interest_accrued(timestamp, future)
    }

    fn calculate_interest_accrued(&self, timestamp: i64, future: i64) -> u64 {
        let seconds_as_top_bid = timestamp + future - self.last_bid_time;
        msg!("s: {}", seconds_as_top_bid);
        let seconds_since_first_bid = self.loan_complete_time - self.first_bid_time;
        let duration_as_top_bid = seconds_as_top_bid / seconds_since_first_bid;
        let interest_rate = self.interest_rate / 100;
        let max_interest = interest_rate * self.loan_amount;
        msg!("m: {}", max_interest);

        duration_as_top_bid as u64 * max_interest
    }

    fn calculate_required_repayment(&self, timestamp: i64, future: i64) -> u64 {
        self.loan_amount_drawn + self.calculate_total_interest(timestamp, future)
    }
}

#[error_code]
pub enum ErrorCode {
    CannotCreateLoanInPast,
    LenderDoesNotMatch,
    CannotUnderwriteARepaidLoan,
    CannotUnderwriteExpiredLoan,
    CannotUnderwriteLessThanTopLender,
    CannotUnderwriteMoreThanMaxLoan,
    MaxDrawCapacityReached,
    CannotRepayLoanWith0Bid,
    CannotRepayExpiredLoan,
    CannotCancelLoanWithMoreThanZeroBids,
    CannotSeizeFromRepaidLoan,
    CannotSeizeBeforeExpiry,
}
