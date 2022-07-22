import { findProgramAddressSync } from "@project-serum/anchor/dist/cjs/utils/pubkey";
import { BN, IdlAccounts, IdlTypes, Program } from "@project-serum/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { PawnShop } from "../target/types/pawn_shop";
import { assert } from "chai";
import { PROGRAM_ID as METAPLEX_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata";

import fs from "fs";

// Hack to prune events from the idl to prevent deserialization bug (account struct is not a defined type)
const pawnShopIdl = JSON.parse(
  fs.readFileSync("./target/idl/pawn_shop.json", "utf8")
);
delete pawnShopIdl["events"];
fs.writeFileSync("./target/idl/pawn_shop.json", JSON.stringify(pawnShopIdl));

export type PawnLoan = Omit<
  IdlAccounts<PawnShop>["pawnLoan"],
  "desiredTerms" | "terms"
> & {
  desiredTerms: LoanTerms | null;
  terms: LoanTerms | null;
};
export type LoanTerms = IdlTypes<PawnShop>["LoanTerms"];

export async function requestLoan(
  program: Program<PawnShop>,
  borrowerKeypair: Keypair,
  borrowerPawnTokenAccount: PublicKey,
  pawnMint: PublicKey,
  desiredTerms: LoanTerms
) {
  const pawnLoan = findProgramAddressSync(
    [Buffer.from("pawn_loan"), borrowerPawnTokenAccount.toBuffer()],
    program.programId
  )[0];

  const signature = await program.methods
    .requestLoan(desiredTerms)
    .accounts({
      pawnLoan,
      borrower: borrowerKeypair.publicKey,
      pawnTokenAccount: borrowerPawnTokenAccount,
      pawnMint,
      edition: findMasterEditionPda(pawnMint),
      mplTokenMetadataProgram: METAPLEX_PROGRAM_ID,
    })
    .signers([borrowerKeypair])
    .rpc();

  return {
    signature,
    pawnLoan,
    pawnTokenAccount: borrowerPawnTokenAccount,
  };
}

export async function underwriteLoan(
  program: Program<PawnShop>,
  pawnLoanAddress: PublicKey,
  pawnLoanState: PawnLoan,
  lenderKeypair: Keypair,
  lenderPaymentAccount: PublicKey,
  borrowerPaymentAccount: PublicKey
) {
  const expectedDesiredTerms = pawnLoanState.desiredTerms;
  assert.isNotNull(expectedDesiredTerms);

  // To silence typescript null warning. nulls should still throw instead of exiting.
  if (!expectedDesiredTerms) {
    return;
  }

  const tx = await program.methods
    .underwriteLoan(expectedDesiredTerms, pawnLoanState.pawnMint)
    .accounts({
      pawnLoan: pawnLoanAddress,
      lender: lenderKeypair.publicKey,
      lenderPaymentAccount: lenderPaymentAccount,
      borrowerPaymentAccount: borrowerPaymentAccount,
    })
    .signers([lenderKeypair])
    .rpc();
}

// Borrower, lender and admin payment accounts are the wallet pk
export async function repayLoanInSol(
  program: Program<PawnShop>,
  pawnLoanAddress: PublicKey,
  pawnLoanState: PawnLoan,
  borrowerKeypair: Keypair,
  adminPda: PublicKey
) {
  return await repayLoan(
    program,
    pawnLoanAddress,
    pawnLoanState,
    borrowerKeypair,
    borrowerKeypair.publicKey /** borrowerPaymentAccount */,
    pawnLoanState.lender /** lenderPaymentAccount */,
    adminPda /** admin pda */,
    adminPda /** adminPaymenAccount */
  );
}

export async function repayLoan(
  program: Program<PawnShop>,
  pawnLoanAddress: PublicKey,
  pawnLoanState: PawnLoan,
  borrowerKeypair: Keypair,
  borrowerPaymentAccount: PublicKey,
  lenderPaymentAccount: PublicKey,
  adminPda: PublicKey,
  adminPaymentAccount: PublicKey
) {
  return await program.methods
    .repayLoan()
    .accounts({
      pawnLoan: pawnLoanAddress,
      pawnTokenAccount: pawnLoanState.pawnTokenAccount,
      pawnMint: pawnLoanState.pawnMint,
      edition: findMasterEditionPda(pawnLoanState.pawnMint),
      borrower: borrowerKeypair.publicKey,
      borrowerPaymentAccount,
      lenderPaymentAccount,
      admin: adminPda,
      adminPaymentAccount,
      mplTokenMetadataProgram: METAPLEX_PROGRAM_ID,
    })
    .signers([borrowerKeypair])
    .rpc();
}

export async function seizePawn(
  program: Program<PawnShop>,
  pawnLoanAddress: PublicKey,
  pawnLoanState: PawnLoan,
  lenderKeypair: Keypair,
  lenderPawnTokenAccount: PublicKey
) {
  return await program.methods
    .seizePawn()
    .accounts({
      pawnLoan: pawnLoanAddress,
      pawnTokenAccount: pawnLoanState.pawnTokenAccount,
      pawnMint: pawnLoanState.pawnMint,
      edition: findMasterEditionPda(pawnLoanState.pawnMint),
      lender: lenderKeypair.publicKey,
      lenderPawnTokenAccount,
      mplTokenMetadataProgram: METAPLEX_PROGRAM_ID,
    })
    .signers([lenderKeypair])
    .rpc();
}

export function findMasterEditionPda(mint: PublicKey): PublicKey {
  const [masterEdition] = findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METAPLEX_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
      Buffer.from("edition"),
    ],
    METAPLEX_PROGRAM_ID
  );
  return masterEdition;
}
