import * as anchor from "@project-serum/anchor";
import { BN, IdlAccounts, IdlTypes, Program } from "@project-serum/anchor";
import { findProgramAddressSync } from "@project-serum/anchor/dist/cjs/utils/pubkey";
import { NATIVE_MINT, Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";
import { PawnShop } from "../target/types/pawn_shop";
import { deserializeTokenAccountInfo } from "./utils";
import { PublicKey, Keypair } from "@solana/web3.js";

const BORROWER_KEYPAIR = new Keypair();
const PAWN_LOAN_KEYPAIR = new Keypair();
const LENDER_KEYPAIR = new Keypair();

export type PawnLoan = Omit<
  IdlAccounts<PawnShop>["pawnLoan"],
  "desiredTerms" | "terms"
> & {
  desiredTerms: LoanTerms | null;
  terms: LoanTerms | null;
};
export type LoanTerms = IdlTypes<PawnShop>["LoanTerms"];

async function requestLoan(
  program: Program<PawnShop>,
  pawnLoanKeypair: Keypair,
  borrowerKeypair: Keypair,
  pawnMint: PublicKey,
  borrowerPawnTokenAccount: PublicKey,
  expectedDesiredTerms: LoanTerms
) {
  const borrower = borrowerKeypair.publicKey;

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
      borrower,
      borrowerPawnTokenAccount,
    })
    .signers([pawnLoanKeypair, borrowerKeypair])
    .rpc();

  return {
    signature,
    pawnTokenAccount,
  };
}

describe("pawn-shop", () => {
  // Configure the client to use the local cluster.
  const anchorProvider = anchor.Provider.env();
  anchorProvider.opts.skipPreflight = true;
  anchorProvider.opts.commitment = "confirmed";
  anchor.setProvider(anchorProvider);
  // set("debug-logs");

  const program = anchor.workspace.PawnShop as Program<PawnShop>;

  it("Request loan", async () => {
    const provider = program.provider;
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        BORROWER_KEYPAIR.publicKey,
        10_000_000_000
      ),
      "confirmed"
    );

    const expectedDesiredTerms: LoanTerms = {
      principalAmount: new BN(1),
      mint: NATIVE_MINT,
      annualPercentageRateBps: new BN(1_000),
      duration: new BN(1234),
    };

    // Create mint and mint token
    const mintA = await Token.createMint(
      provider.connection,
      BORROWER_KEYPAIR,
      BORROWER_KEYPAIR.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    const borrowerPawnTokenAccount = await mintA.createAccount(
      BORROWER_KEYPAIR.publicKey
    );
    await mintA.mintTo(borrowerPawnTokenAccount, BORROWER_KEYPAIR, [], 1);

    await requestLoan(
      program,
      PAWN_LOAN_KEYPAIR,
      BORROWER_KEYPAIR,
      mintA.publicKey,
      borrowerPawnTokenAccount,
      expectedDesiredTerms
    );

    const pawnLoan = await program.account.pawnLoan.fetch(
      PAWN_LOAN_KEYPAIR.publicKey
    );
    const desiredTerms = pawnLoan.desiredTerms;

    assert.isTrue(pawnLoan.borrower.equals(BORROWER_KEYPAIR.publicKey));
    assert.isTrue(
      desiredTerms?.principalAmount.eq(expectedDesiredTerms.principalAmount)
    );
    assert.isTrue(desiredTerms?.mint.equals(expectedDesiredTerms.mint));
    assert.isTrue(
      desiredTerms?.annualPercentageRateBps.eq(
        expectedDesiredTerms.annualPercentageRateBps
      )
    );
    assert.isTrue(desiredTerms?.duration.eq(expectedDesiredTerms.duration));
    assert.isNull(pawnLoan.terms);
  });

  it("Underwrite Loan", async () => {
    const provider = program.provider;

    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        LENDER_KEYPAIR.publicKey,
        10_000_000_000
      ),
      "confirmed"
    );

    const pawnLoan = await program.account.pawnLoan.fetch(
      PAWN_LOAN_KEYPAIR.publicKey
    );
    const pawnTokenAccount = findProgramAddressSync(
      [
        Buffer.from("pawn-token-account"),
        PAWN_LOAN_KEYPAIR.publicKey.toBuffer(),
      ],
      program.programId
    )[0];

    const pawnTokenAccountInfo =
      await program.provider.connection.getAccountInfo(pawnTokenAccount);

    const decodedPawnTokenAccountInfo = deserializeTokenAccountInfo(
      pawnTokenAccountInfo?.data
    );

    const expectedPawnMint = decodedPawnTokenAccountInfo?.mint;
    const expectedDesiredTerms = pawnLoan?.desiredTerms;

    assert.isNotNull(expectedDesiredTerms);
    assert.isNotNull(expectedPawnMint);
    // To silence typescript null warning. Nulls should still throw instead of exiting.
    if (!expectedDesiredTerms || !expectedPawnMint) {
      return;
    }

    const tx = await program.methods
      .underwriteLoan(expectedDesiredTerms, expectedPawnMint, new BN(1))
      .accounts({
        pawnLoan: PAWN_LOAN_KEYPAIR.publicKey,
        pawnTokenAccount,
        lender: LENDER_KEYPAIR.publicKey,
        lenderPaymentAccount: LENDER_KEYPAIR.publicKey,
        borrowerPaymentAccount: pawnLoan.borrower,
      })
      .signers([LENDER_KEYPAIR])
      .rpc();

    const pawnLoanAfter = await program.account.pawnLoan.fetch(
      PAWN_LOAN_KEYPAIR.publicKey
    );
    const terms = pawnLoanAfter.terms;

    assert.isTrue(
      terms?.principalAmount.eq(expectedDesiredTerms.principalAmount)
    );
    assert.isTrue(pawnLoanAfter.lender.equals(LENDER_KEYPAIR.publicKey));
  });

  it("Repay Loan", async () => {
    // TODO
  });

  it("Cancel loan", async () => {
    const provider = program.provider;
    const pawnLoanKeypair = new Keypair();
    const expectedDesiredTerms: LoanTerms = {
      principalAmount: new BN(1),
      mint: NATIVE_MINT,
      annualPercentageRateBps: new BN(1_000),
      duration: new BN(1234),
    };

    // Create mint and mint token
    const mintA = await Token.createMint(
      provider.connection,
      BORROWER_KEYPAIR,
      BORROWER_KEYPAIR.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    const borrowerPawnTokenAccount = await mintA.createAccount(
      BORROWER_KEYPAIR.publicKey
    );
    await mintA.mintTo(borrowerPawnTokenAccount, BORROWER_KEYPAIR, [], 1);

    const { pawnTokenAccount } = await requestLoan(
      program,
      pawnLoanKeypair,
      BORROWER_KEYPAIR,
      mintA.publicKey,
      borrowerPawnTokenAccount,
      expectedDesiredTerms
    );

    await program.methods
      .cancelLoan()
      .accounts({
        pawnLoan: pawnLoanKeypair.publicKey,
        pawnTokenAccount,
        borrower: BORROWER_KEYPAIR.publicKey,
        borrowerPawnTokenAccount,
      })
      .signers([BORROWER_KEYPAIR])
      .rpc();

    // Relevant accounts should be zeroed (back to system program and no lamports) and pawn back in wallet
    const pawnLoanAccountInfo =
      await program.provider.connection.getAccountInfo(
        pawnLoanKeypair.publicKey
      );
    assert.isNull(pawnLoanAccountInfo);

    const pawnTokenAccountInfo =
      await program.provider.connection.getAccountInfo(pawnTokenAccount);
    assert.isNull(pawnTokenAccountInfo);

    const borrowerPawnTokenAccountInfo =
      await program.provider.connection.getAccountInfo(
        borrowerPawnTokenAccount
      );

    const decodedBorrowerPawnTokenAccountInfo = deserializeTokenAccountInfo(
      borrowerPawnTokenAccountInfo?.data
    );
    assert.isTrue(decodedBorrowerPawnTokenAccountInfo?.amount.eq(new BN(1)));
  });
});
