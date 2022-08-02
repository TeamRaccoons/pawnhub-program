use std::{cmp, convert::TryInto};

use anchor_lang::{prelude::*, solana_program::program::invoke_signed, system_program};
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use mpl_token_metadata::instruction::{freeze_delegated_account, thaw_delegated_account};
use vipers::prelude::*;

mod macros;
use macros::{freeze_pawn_token_account, thaw_pawn_token_account};

const ADMIN_FEE_BPS: u64 = 200; // 2%
const SECONDS_PER_YEAR: u64 = 31_536_000;
const MINIMUM_PERIOD_RATIO_BPS: u64 = 2_500; // 25%

mod native_mint {
    use super::*;
    declare_id!("So11111111111111111111111111111111111111112");
}

/// The authority allowed to withdraw admin fees
mod fee_collector {
    use super::*;
    #[cfg(feature = "mainnet")]
    declare_id!("BUX7s2ef2htTGb2KKoPHWkmzxPj4nTWMWRgs5CSbQxf9"); // Raccoons multisig
    #[cfg(not(feature = "mainnet"))]
    declare_id!("HNodM9dfJf84YdVJQrjg6rSzHdb5WNbQo5xkvYBiNnLT"); // Test harcoded keypair, /!\ do not use in production
}

#[cfg(not(any(feature = "devnet", feature = "mainnet")))]
declare_id!("PawnShop11111111111111111111111111111111112");

#[cfg(feature = "devnet")]
declare_id!("GLcEe1BaCDWcis4sWhCVB95ti7GjR9tHD2M9Y2Q5gV9H");

#[cfg(feature = "mainnet")]
declare_id!("PawnLnfQT8tszFmSqdJHb2377ou74z3p6R4Eu1FCeyL");

#[program]
pub mod pawn_shop {
    use super::*;

    /// Borrower opens a loan request. Pawn is frozen
    pub fn request_loan(ctx: Context<RequestLoan>, desired_terms: Option<LoanTerms>) -> Result<()> {
        {
            let unix_timestamp = Clock::get()?.unix_timestamp;
            let pawn_loan = &mut ctx.accounts.pawn_loan;

            pawn_loan.base = ctx.accounts.base.key();
            pawn_loan.bump = unwrap_bump!(ctx, "pawn_loan");
            pawn_loan.status = LoanStatus::Open;
            pawn_loan.borrower = ctx.accounts.borrower.key();
            pawn_loan.pawn_token_account = ctx.accounts.pawn_token_account.key();
            pawn_loan.pawn_mint = ctx.accounts.pawn_mint.key();
            match &desired_terms {
                Some(terms) => {
                    invariant!(terms.principal_amount != 0, InvalidLoanTerms);
                    invariant!(terms.annual_percentage_rate_bps != 0, InvalidLoanTerms);
                    invariant!(terms.duration > 0, InvalidLoanTerms);
                }
                _ => (),
            }
            pawn_loan.desired_terms = desired_terms;
            pawn_loan.creation_time = unix_timestamp;

            // Freeze the pawn token account
            token::approve(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    token::Approve {
                        to: ctx.accounts.pawn_token_account.to_account_info(),
                        delegate: ctx.accounts.pawn_loan.to_account_info(),
                        authority: ctx.accounts.borrower.to_account_info(),
                    },
                ),
                1,
            )?;

            freeze_pawn_token_account!(ctx);
        }

        emit!(LoanRequested {
            pawn_loan_address: ctx.accounts.pawn_loan.key(),
            pawn_loan: *ctx.accounts.pawn_loan,
        });

        Ok(())
    }

    /// Lender funds the loan request and the loan starts. Funds are transferred to Borrower wallet.
    pub fn underwrite_loan(
        ctx: Context<UnderwriteLoan>,
        expected_terms: LoanTerms,
        expected_pawn_mint: Pubkey,
    ) -> Result<()> {
        {
            let unix_timestamp = Clock::get()?.unix_timestamp;
            let pawn_loan = &mut ctx.accounts.pawn_loan;

            invariant!(pawn_loan.status == LoanStatus::Open, InvalidLoanStatus);

            let terms = unwrap_opt!(pawn_loan.desired_terms.clone());
            pawn_loan.status = LoanStatus::Active;
            pawn_loan.start_time = unix_timestamp;
            pawn_loan.lender = ctx.accounts.lender.key();

            // Verify loan matches lender expectation
            invariant!(expected_terms == terms, UnexpectedDesiredTerms);
            assert_keys_eq!(expected_pawn_mint, pawn_loan.pawn_mint, UnexpectedPawnMint);

            let principal_amount = terms.principal_amount;
            let loan_mint = terms.mint;
            pawn_loan.terms = Some(terms.clone());

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
                assert_keys_eq!(pawn_loan.borrower, borrower_payment_token_account.owner);
                assert_keys_eq!(loan_mint, borrower_payment_token_account.mint);

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
        }

        emit!(LoanUnderwritten {
            pawn_loan_address: ctx.accounts.pawn_loan.key(),
            pawn_loan: *ctx.accounts.pawn_loan,
        });

        Ok(())
    }

    /// Borrower pays back loan amount plus interest and gets the pawn back.
    /// Lender gets back loan amount plus interest minus admin fee.
    pub fn repay_loan(ctx: Context<RepayLoan>) -> Result<()> {
        {
            let unix_timestamp = Clock::get()?.unix_timestamp;
            let pawn_loan = &mut ctx.accounts.pawn_loan;

            invariant!(pawn_loan.status == LoanStatus::Active, InvalidLoanStatus);

            pawn_loan.status = LoanStatus::Repaid;

            let terms = unwrap_opt!(pawn_loan.terms.clone());
            let interest_due = compute_interest_due(&terms, pawn_loan.start_time, unix_timestamp)?;
            let admin_fee = compute_admin_fee(interest_due, ADMIN_FEE_BPS)
                .ok_or(ErrorCode::CalculationError)?;
            let payoff_amount =
                compute_payoff_amount(terms.principal_amount, interest_due, admin_fee)
                    .ok_or(ErrorCode::CalculationError)?;
            pawn_loan.end_time = unix_timestamp;

            // Transfer payoff to lender and admin fee.
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
                assert_keys_eq!(terms.mint, lender_payment_token_account.mint);

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
                assert_keys_eq!(terms.mint, admin_payment_token_account.mint);

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

            thaw_pawn_token_account!(ctx);
            token::revoke(CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Revoke {
                    source: ctx.accounts.pawn_token_account.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ))?;
        }

        emit!(LoanRepaid {
            pawn_loan_address: ctx.accounts.pawn_loan.key(),
            pawn_loan: *ctx.accounts.pawn_loan,
        });

        Ok(())
    }

    // Closes the loan request and thaw pawn.
    pub fn cancel_loan(ctx: Context<CancelLoan>) -> Result<()> {
        let pawn_loan = &mut ctx.accounts.pawn_loan;

        invariant!(pawn_loan.status == LoanStatus::Open, InvalidLoanStatus);

        thaw_pawn_token_account!(ctx);
        token::revoke(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Revoke {
                source: ctx.accounts.pawn_token_account.to_account_info(),
                authority: ctx.accounts.borrower.to_account_info(),
            },
        ))?;

        Ok(())
    }

    /// Lender seizes pawn from program escrow when loan is overdue.
    pub fn seize_pawn(ctx: Context<SeizePawn>) -> Result<()> {
        {
            let unix_timestamp = Clock::get()?.unix_timestamp;
            let pawn_loan = &mut ctx.accounts.pawn_loan;

            invariant!(pawn_loan.status == LoanStatus::Active, InvalidLoanStatus);

            let terms = unwrap_opt!(pawn_loan.terms.clone());
            let overdue_time = unwrap_int!(pawn_loan.start_time.checked_add(terms.duration));
            invariant!(overdue_time < unix_timestamp, CannotSeizeBeforeExpiry);
            pawn_loan.status = LoanStatus::Defaulted;
            pawn_loan.end_time = unix_timestamp;

            // Thaw token account then transfer to lender
            thaw_pawn_token_account!(ctx);
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: ctx.accounts.pawn_token_account.to_account_info(),
                        to: ctx.accounts.lender_pawn_token_account.to_account_info(),
                        authority: ctx.accounts.pawn_loan.to_account_info(),
                    },
                    &[&[
                        ctx.accounts.pawn_loan.base.as_ref(),
                        b"pawn_loan".as_ref(),
                        &[ctx.accounts.pawn_loan.bump],
                    ]],
                ),
                ctx.accounts.pawn_token_account.amount,
            )?;
        }

        emit!(PawnSeized {
            pawn_loan_address: ctx.accounts.pawn_loan.key(),
            pawn_loan: *ctx.accounts.pawn_loan,
        });

        Ok(())
    }

    /// Withdraw admin fees into the fee collector wallet.
    pub fn withdraw_admin_fees(ctx: Context<WithdrawAdminFees>) -> Result<()> {
        let admin_bump = unwrap_bump!(ctx, "admin");
        let signer_seeds: &[&[&[u8]]] = &[&[b"admin".as_ref(), &[admin_bump]]];

        if ctx.accounts.admin.key == ctx.accounts.admin_payment_account.key {
            // Only withdraw what would leave the system program account rent exempt to avoid blocking repayments
            let admin_account_info = ctx.accounts.admin.to_account_info();
            let minimum_balance = Rent::get()?.minimum_balance(admin_account_info.data_len());
            let amount = admin_account_info
                .lamports()
                .saturating_sub(minimum_balance);

            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.admin_payment_account.to_account_info(),
                        to: ctx.accounts.fee_collector_payment_account.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount,
            )?;
        } else {
            let admin_fee_token_account: Account<TokenAccount> =
                Account::try_from(&ctx.accounts.admin_payment_account)?;
            assert_keys_eq!(ctx.accounts.admin, admin_fee_token_account.owner);

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: ctx.accounts.admin_payment_account.to_account_info(),
                        to: ctx.accounts.fee_collector_payment_account.to_account_info(),
                        authority: ctx.accounts.admin.to_account_info(),
                    },
                    signer_seeds,
                ),
                admin_fee_token_account.amount,
            )?;
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct RequestLoan<'info> {
    #[account(mut)]
    pub base: Signer<'info>,
    #[account(init, seeds = [base.key.as_ref(), b"pawn_loan".as_ref()], bump, payer = borrower, space = PawnLoan::space())]
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(mut, token::mint = pawn_mint)]
    pub pawn_token_account: Account<'info, TokenAccount>,
    pub pawn_mint: Account<'info, Mint>,
    /// CHECK: Validated by the cpi to mpl token metadata
    pub edition: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub mpl_token_metadata_program: Program<'info, MplTokenMetadata>,
    pub system_program: Program<'info, System>,
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
pub struct RepayLoan<'info> {
    #[account(mut, has_one = pawn_token_account, has_one = pawn_mint, has_one = borrower)]
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub pawn_token_account: Account<'info, TokenAccount>,
    pub pawn_mint: Account<'info, Mint>,
    /// CHECK: Validated by the cpi to mpl token metadata
    pub edition: UncheckedAccount<'info>,
    pub borrower: Signer<'info>,
    /// CHECK: Sends the payoff, can be the borrower wallet or his spl token account
    #[account(mut)]
    pub borrower_payment_account: UncheckedAccount<'info>,
    /// CHECK: Receives the payoff, can be the lender wallet or his spl token account
    #[account(mut)]
    pub lender_payment_account: UncheckedAccount<'info>,
    #[account(seeds = [b"admin"], bump)]
    pub admin: SystemAccount<'info>,
    /// CHECK: Receives admin fee, can be the admin pda or a spl token account owned by the admin pda
    #[account(mut)]
    pub admin_payment_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub mpl_token_metadata_program: Program<'info, MplTokenMetadata>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelLoan<'info> {
    #[account(mut, has_one = borrower, has_one = pawn_token_account, has_one = pawn_mint, close = borrower)]
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(mut)]
    pub pawn_token_account: Account<'info, TokenAccount>,
    pub pawn_mint: Account<'info, Mint>,
    /// CHECK: Validated by the cpi to mpl token metadata
    pub edition: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub mpl_token_metadata_program: Program<'info, MplTokenMetadata>,
}

#[derive(Accounts)]
pub struct SeizePawn<'info> {
    #[account(mut, has_one = lender, has_one = pawn_token_account, has_one = pawn_mint)]
    pub pawn_loan: Account<'info, PawnLoan>,
    #[account(mut)]
    pub pawn_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub pawn_mint: Account<'info, Mint>,
    /// CHECK: Validated by the cpi to mpl token metadata
    pub edition: UncheckedAccount<'info>,
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(mut)]
    pub lender_pawn_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub mpl_token_metadata_program: Program<'info, MplTokenMetadata>,
}

#[derive(Accounts)]
pub struct WithdrawAdminFees<'info> {
    #[account(address = fee_collector::ID)]
    pub fee_collector: Signer<'info>,
    /// CHECK: Receives the admin fees, can be the fee collector wallet or his spl token account
    #[account(mut)]
    pub fee_collector_payment_account: UncheckedAccount<'info>,
    #[account(seeds = [b"admin"], bump)]
    pub admin: SystemAccount<'info>,
    /// CHECK: Sends the admin fees, can be the admin pda or a spl token account owned by the admin pda
    #[account(mut)]
    pub admin_payment_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq)]
pub enum LoanStatus {
    Open,
    Active,
    Repaid,
    Defaulted,
}

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq)]
pub struct LoanTerms {
    pub principal_amount: u64,
    pub mint: Pubkey,
    pub annual_percentage_rate_bps: u64,
    pub duration: i64,
}

impl LoanTerms {
    fn space() -> usize {
        8 + 32 + 8 + 8
    }
}

#[account]
#[derive(Copy)]
pub struct PawnLoan {
    pub base: Pubkey,
    pub bump: u8,
    pub borrower: Pubkey,
    pub pawn_token_account: Pubkey,
    pub pawn_mint: Pubkey,
    pub status: LoanStatus,
    pub lender: Pubkey,
    pub desired_terms: Option<LoanTerms>,
    pub terms: Option<LoanTerms>,
    pub creation_time: i64,
    pub start_time: i64,
    pub end_time: i64,
}

impl PawnLoan {
    fn space() -> usize {
        8 + 32 + 1 + 32 + 32 + 32 + 1 + 32 + 2 * (1 + LoanTerms::space()) + 8 + 8 + 8
    }
}

pub fn compute_admin_fee(interest_due: u64, admin_fee_bps: u64) -> Option<u64> {
    u128::from(interest_due)
        .checked_mul(admin_fee_bps.into())?
        .checked_div(10_000)?
        .try_into()
        .ok()
}

pub fn compute_payoff_amount(
    principal_amount: u64,
    interest_due: u64,
    admin_fee: u64,
) -> Option<u64> {
    u128::from(principal_amount)
        .checked_add(interest_due.into())?
        .checked_sub(admin_fee.into())?
        .try_into()
        .ok()
}

fn compute_minimum_interest_duration(duration: u64) -> Option<i64> {
    u128::from(duration)
        .checked_mul(MINIMUM_PERIOD_RATIO_BPS.into())?
        .checked_div(10_000)?
        .try_into()
        .ok()
}

pub fn compute_interest_due(terms: &LoanTerms, start_time: i64, timestamp: i64) -> Result<u64> {
    let elapsed_time = unwrap_int!(timestamp.checked_sub(start_time));
    let minimum_interest_duration = compute_minimum_interest_duration(terms.duration as u64)
        .ok_or(ErrorCode::CalculationError)?;

    // The effective elapsed time will be at least the minimum interest duration.
    let effective_elapsed_time = cmp::max(elapsed_time, minimum_interest_duration);

    u128::from(terms.principal_amount)
        .checked_mul(terms.annual_percentage_rate_bps.into())
        .ok_or(ErrorCode::CalculationError)?
        .checked_mul((effective_elapsed_time as u64).into())
        .ok_or(ErrorCode::CalculationError)?
        .checked_div(u128::from(SECONDS_PER_YEAR * 10_000))
        .ok_or(ErrorCode::CalculationError)?
        .try_into()
        .map_err(|_| error!(ErrorCode::CalculationError))
}

#[error_code]
pub enum ErrorCode {
    PawnAmountIsZero,
    InvalidLoanTerms,
    CalculationError,
    InvalidLoanStatus,
    UnexpectedDesiredTerms,
    UnexpectedPawnMint,
    UnexpectedPawnAmount,
    CannotCancelLoanWithMoreThanZeroBids,
    CannotSeizeBeforeExpiry,
}

#[event]
pub struct LoanRequested {
    pawn_loan_address: Pubkey,
    pawn_loan: PawnLoan,
}

#[event]
pub struct LoanUnderwritten {
    pawn_loan_address: Pubkey,
    pawn_loan: PawnLoan,
}

#[event]
pub struct LoanRepaid {
    pawn_loan_address: Pubkey,
    pawn_loan: PawnLoan,
}

#[event]
pub struct PawnSeized {
    pawn_loan_address: Pubkey,
    pawn_loan: PawnLoan,
}

#[derive(Debug, Clone)]
pub struct MplTokenMetadata;

impl anchor_lang::Id for MplTokenMetadata {
    fn id() -> Pubkey {
        mpl_token_metadata::ID
    }
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
            compute_interest_due(&terms, 123456789, 123456789 + terms.duration as i64).unwrap()
        );

        // Half duration
        assert_eq!(
            16_780_821,
            compute_interest_due(&terms, 123456789, 123456789 + terms.duration as i64 / 2).unwrap()
        );

        // 10% of the duration should be brought back to 25% of duration as it is the minimum chargeable duration
        assert_eq!(
            8_390_410,
            compute_interest_due(&terms, 123456789, 123456789 + terms.duration as i64 / 10)
                .unwrap()
        );
    }

    #[test]
    fn compute_admin_fee_positive_interest() {
        const POSITIVE_INTEREST: u64 = 100;

        assert_eq!(
            ADMIN_FEE_BPS * POSITIVE_INTEREST / 10_000,
            compute_admin_fee(POSITIVE_INTEREST, ADMIN_FEE_BPS).unwrap()
        );
    }

    #[test]
    fn compute_admin_fee_zero_interest() {
        // Zero interest
        assert_eq!(0, compute_admin_fee(0, ADMIN_FEE_BPS).unwrap());
    }

    #[test]
    fn compute_payoff_amount_is_correct() {
        assert_eq!(
            1234 + 5678 - 10,
            compute_payoff_amount(1234, 5678, 10).unwrap()
        );

        // Overflow cases: one too much
        assert_eq!(None, compute_payoff_amount(u64::MAX, 1, 0));
        assert_eq!(None, compute_payoff_amount(u64::MAX, 2, 1));
    }
}
