use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

#[cfg(feature = "devnet")]
declare_id!("4tceu2BHCUowrdSH8JS2JcZoL7mFUxvrfqXHpDYp3CvL");

#[cfg(not(feature = "devnet"))]
declare_id!("Faucet11111111111111111111111111111111111112");

#[program]
pub mod faucet {
    use super::*;

    pub fn create_faucet(ctx: Context<CreateFaucet>, _decimals: u8, amount: u64) -> Result<()> {
        ctx.accounts.faucet.bump = *ctx.bumps.get("faucet").unwrap();
        ctx.accounts.faucet.amount = amount;
        ctx.accounts.faucet.mint = ctx.accounts.mint.key();
        Ok(())
    }

    pub fn request_tokens(ctx: Context<RequestTokens>) -> Result<()> {
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.requester_token_account.to_account_info(),
                    authority: ctx.accounts.faucet.to_account_info(),
                },
                &[&[
                    b"faucet",
                    ctx.accounts.mint.key().as_ref(),
                    &[ctx.accounts.faucet.bump],
                ]],
            ),
            ctx.accounts.faucet.amount,
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(decimals: u8)]
pub struct CreateFaucet<'info> {
    #[account(init, seeds = [b"faucet", mint.key().as_ref()], bump, space = 100, payer = payer)]
    pub faucet: Account<'info, Faucet>,
    #[account(init, mint::decimals = decimals, mint::authority = faucet, payer = payer)]
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestTokens<'info> {
    #[account(mut, has_one = mint)]
    pub faucet: Account<'info, Faucet>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub requester_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Faucet {
    bump: u8,
    mint: Pubkey,
    amount: u64,
}
