// source https://github.com/metaplex-foundation/metaplex-program-library/tree/master/token-metadata/program
// Reduced to the bare minimum for our CPI needs
use anchor_lang::{prelude::*, solana_program::instruction::Instruction};
use anchor_spl::token;

pub fn freeze_delegated_account(
    program_id: Pubkey,
    delegate: Pubkey,
    token_account: Pubkey,
    edition: Pubkey,
    mint: Pubkey,
) -> Instruction {
    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(delegate, true),
            AccountMeta::new(token_account, false),
            AccountMeta::new_readonly(edition, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(token::ID, false),
        ],
        data: vec![26],
    }
}

pub fn thaw_delegated_account(
    program_id: Pubkey,
    delegate: Pubkey,
    token_account: Pubkey,
    edition: Pubkey,
    mint: Pubkey,
) -> Instruction {
    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(delegate, true),
            AccountMeta::new(token_account, false),
            AccountMeta::new_readonly(edition, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(token::ID, false),
        ],
        data: vec![27],
    }
}

// Use enum serialization with ShankInstruction format if we ever expand the required ix set
enum MetadataInstruction {
    FreezeDelegatedAccount,
    ThawDelegatedAccount,
}