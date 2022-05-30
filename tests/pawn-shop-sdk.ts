import { findProgramAddressSync } from "@project-serum/anchor/dist/cjs/utils/pubkey";
import { BN, IdlAccounts, IdlTypes, Program } from "@project-serum/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { PawnShop } from "../target/types/pawn_shop";
import { assert } from "chai";
import { deserializeTokenAccountInfo } from "./utils";

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
  pawnLoanKeypair: Keypair,
  borrowerKeypair: Keypair,
  pawnMint: PublicKey,
  borrowerPawnTokenAccount: PublicKey,
  expectedDesiredTerms: LoanTerms
) {
  const pawnTokenAccount = findProgramAddressSync(
    [Buffer.from("pawn-token-account"), pawnLoanKeypair.publicKey.toBuffer()],
    program.programId
  )[0];

  const signature = await program.methods
    .requestLoan(new BN(1), expectedDesiredTerms)
    .accounts({
      pawnLoan: pawnLoanKeypair.publicKey,
      pawnTokenAccount,
      pawnMint,
      borrower: borrowerKeypair.publicKey,
      borrowerPawnTokenAccount,
    })
    .signers([pawnLoanKeypair, borrowerKeypair])
    .rpc();

  return { signature, pawnTokenAccount };
}

export async function underwriteLoan(
  program: Program<PawnShop>,
  pawnLoan: PawnLoan,
  pawnLoanKeypair: Keypair,
  pawnTokenAccount: PublicKey,
  lenderKeypair: Keypair,
  lenderPaymentAccount: PublicKey,
  borrowerPaymentAccount: PublicKey
) {
  const pawnTokenAccountInfo = await program.provider.connection.getAccountInfo(
    pawnTokenAccount
  );
  const decodedPawnTokenAccountInfo = deserializeTokenAccountInfo(
    pawnTokenAccountInfo?.data
  );

  const expectedPawnMint = decodedPawnTokenAccountInfo?.mint;
  const expectedDesiredTerms = pawnLoan.desiredTerms;
  assert.isNotNull(expectedDesiredTerms);
  assert.isNotNull(expectedPawnMint);
  // To silence typescript null warning. Nulls should still throw instead of exiting.
  if (!expectedDesiredTerms || !expectedPawnMint) {
    return;
  }

  const tx = await program.methods
    .underwriteLoan(expectedDesiredTerms, expectedPawnMint, new BN(1))
    .accounts({
      pawnLoan: pawnLoanKeypair.publicKey,
      pawnTokenAccount,
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
  pawnLoanKeypair: Keypair,
  pawnTokenAccount: PublicKey,
  borrowerKeypair: Keypair,
  borrowerPawnTokenAccount: PublicKey,
  lenderWallet: PublicKey,
  adminPda: PublicKey
) {
  return await repayLoan(
    program,
    pawnLoanKeypair,
    pawnTokenAccount,
    borrowerKeypair,
    borrowerKeypair.publicKey /** borrowerPaymentAccount */,
    borrowerPawnTokenAccount,
    lenderWallet /** lenderPaymentAccount */,
    adminPda /** admin pda */,
    adminPda /** adminPaymenAccount */
  );
}

export async function repayLoan(
  program: Program<PawnShop>,
  pawnLoanKeypair: Keypair,
  pawnTokenAccount: PublicKey,
  borrowerKeypair: Keypair,
  borrowerPaymentAccount: PublicKey,
  borrowerPawnTokenAccount: PublicKey,
  lenderPaymentAccount: PublicKey,
  adminPda: PublicKey,
  adminPaymentAccount: PublicKey
) {
  return await program.methods
    .repayLoan()
    .accounts({
      pawnLoan: pawnLoanKeypair.publicKey,
      pawnTokenAccount,
      borrower: borrowerKeypair.publicKey,
      borrowerPaymentAccount,
      borrowerPawnTokenAccount,
      lenderPaymentAccount,
      admin: adminPda,
      adminPaymentAccount,
    })
    .signers([borrowerKeypair])
    .rpc();
}

export async function seizePawn(
  program: Program<PawnShop>,
  pawnLoan: PublicKey,
  pawnTokenAccount: PublicKey,
  lenderKeypair: Keypair,
  lenderPawnTokenAccount: PublicKey
) {
  return await program.methods
    .seizePawn()
    .accounts({
      pawnLoan,
      pawnTokenAccount,
      lender: lenderKeypair.publicKey,
      lenderPawnTokenAccount,
    })
    .signers([lenderKeypair])
    .rpc();
}
