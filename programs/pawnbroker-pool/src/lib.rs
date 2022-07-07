use std::{cmp, convert::TryInto};

use anchor_lang::{prelude::*, solana_program::program::invoke_signed, system_program};
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use pawn_loan::accounts::PawnLoan;
use vipers::prelude::*;

mod native_mint {
    use super::*;
    declare_id!("So11111111111111111111111111111111111111112");
}

#[cfg(not(any(feature = "devnet", feature = "mainnet")))]
declare_id!("PawnbrokerPoo111111111111111111111111111112");

#[cfg(feature = "devnet")]
declare_id!("PawnbrokerPoo111111111111111111111111111112");

#[cfg(feature = "mainnet")]
declare_id!("PawnbrokerPoo111111111111111111111111111112");

#[program]
pub mod pawnbroker_pool {
    use super::*;

 
}

#[derive(Accounts)]
pub struct DepositOrWithdraw<'info> {
    #[account(has_one = vault)]
    pub pawnbroker_pool: Account<'info, PawnbrokerPool>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnderwriteLoan<'info> {
    pub pawnbroker_pool: Account<'info, PawnbrokerPool>,
    #[account(mut)]
    pub vault: SystemAccount<'info>,
    #[account(mut)]
    pub pawn_loan: Account<'info, PawnLoan>,
    /// CHECK: Sends the principal, can be the lender wallet or his spl token account
    #[account(mut)]
    pub lender_payment_account: UncheckedAccount<'info>,
    /// CHECK: Receives the principal, can be the borrower wallet or his spl token account
    #[account(mut)]
    pub borrower_payment_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(Copy)]
pub struct PawnbrokerPool {
    pub base: Pubkey,
    pub bump: u8,
    pub vault: Pubkey,
    pub admin: Pubkey,
}

#[account]
pub struct CollectionSettings {
    pub collection: CollectionIdentifier,
    /// Percentage max LTV from 0 to 100
    pub max_loan_to_value: u8,
    /// Floor price in lamports
    pub floor_price: u64,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize, PartialEq)]
enum CollectionIdentifier {
    /// Collection is identified by a verified collection
    Collection { address: Pubkey },
    // Collection is identified by its first verified creator, often the candy machine ID
    Creator { address: Pubkey, symbol: String },
}

impl PawnbrokerPool {
    fn space() -> usize {
        8 + 32 + 1 + 32 + 32 + 32 + 1 + 32 + 2 * (1 + LoanTerms::space()) + 8 + 8 + 8
    }
}

#[error_code]
pub enum ErrorCode {
    Bla,
}

#[cfg(test)]
mod tests {
    use super::*;


}
