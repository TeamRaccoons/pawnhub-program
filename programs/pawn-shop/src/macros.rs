macro_rules! freeze_pawn_token_account {
    ($ctx:expr) => {{
        invoke_signed(
            &freeze_delegated_account(
                mpl_token_metadata::ID,
                $ctx.accounts.pawn_loan.key(),
                $ctx.accounts.pawn_token_account.key(),
                $ctx.accounts.edition.key(),
                $ctx.accounts.pawn_mint.key(),
            ),
            &[
                $ctx.accounts.pawn_loan.to_account_info(),
                $ctx.accounts.pawn_token_account.to_account_info(),
                $ctx.accounts.edition.to_account_info(),
                $ctx.accounts.pawn_mint.to_account_info(),
            ],
            &[&[
                $ctx.accounts.pawn_loan.base.as_ref(),
                b"pawn-loan".as_ref(),
                &[unwrap_bump!($ctx, "pawn-loan")],
            ]],
        )?;
    }};
}

macro_rules! thaw_pawn_token_account {
    ($ctx:expr) => {{
        invoke_signed(
            &thaw_delegated_account(
                mpl_token_metadata::ID,
                $ctx.accounts.pawn_loan.key(),
                $ctx.accounts.pawn_token_account.key(),
                $ctx.accounts.edition.key(),
                $ctx.accounts.pawn_mint.key(),
            ),
            &[
                $ctx.accounts.pawn_loan.to_account_info(),
                $ctx.accounts.pawn_token_account.to_account_info(),
                $ctx.accounts.edition.to_account_info(),
                $ctx.accounts.pawn_mint.to_account_info(),
            ],
            &[&[
                $ctx.accounts.pawn_loan.base.as_ref(),
                b"pawn-loan".as_ref(),
                &[$ctx.accounts.pawn_loan.bump],
            ]],
        )?;
    }};
}

pub(crate) use freeze_pawn_token_account;
pub(crate) use thaw_pawn_token_account;