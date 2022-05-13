import * as anchor from "@project-serum/anchor";
import { BN, IdlAccounts, IdlTypes, Program } from "@project-serum/anchor";
import { findProgramAddressSync } from "@project-serum/anchor/dist/cjs/utils/pubkey";
import {
  NATIVE_MINT,
  Token,
  TOKEN_PROGRAM_ID,
  AccountLayout as TokenAccountLayout,
  AccountInfo as TokenAccountInfo,
} from "@solana/spl-token";
import { assert } from "chai";
import { PawnShop } from "../target/types/pawn_shop";
import { deserializeTokenAccountInfo } from "./utils";

const { Keypair } = anchor.web3;

const borrowerKeypair = new Keypair();
const pawnLoanKeypair = new Keypair();
const lenderKeypair = new Keypair();

export type PawnLoan = Omit<
  IdlAccounts<PawnShop>["pawnLoan"],
  "desiredTerms" | "terms"
> & {
  desiredTerms: LoanTerms | null;
  terms: LoanTerms | null;
};
export type LoanTerms = IdlTypes<PawnShop>["LoanTerms"];

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
        borrowerKeypair.publicKey,
        10_000_000_000
      ),
      "confirmed"
    );

    const borrower = provider.wallet.publicKey;

    // Create mint and mint token
    const mintA = await Token.createMint(
      provider.connection,
      borrowerKeypair,
      borrowerKeypair.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    const borrowerPawnTokenAccount = await mintA.createAccount(borrower);

    await mintA.mintTo(borrowerPawnTokenAccount, borrowerKeypair, [], 1);

    const principalAmount = new BN(1);
    const annualPercentageRateBps = new BN(1_000);
    const duration = new BN(1000);

    const pawnTokenAccount = findProgramAddressSync(
      [Buffer.from("pawn-token-account"), pawnLoanKeypair.publicKey.toBuffer()],
      program.programId
    )[0];

    const expectedDesiredTerms: LoanTerms = {
      principalAmount,
      mint: NATIVE_MINT,
      annualPercentageRateBps,
      duration,
    };

    await program.methods
      .requestLoan(new BN(1), expectedDesiredTerms)
      .accounts({
        pawnLoan: pawnLoanKeypair.publicKey,
        pawnTokenAccount,
        pawnMint: mintA.publicKey,
        borrower,
        borrowerPawnTokenAccount,
      })
      .signers([pawnLoanKeypair])
      .rpc();

    const pawnLoan = await program.account.pawnLoan.fetch(
      pawnLoanKeypair.publicKey
    );
    const desiredTerms = pawnLoan.desiredTerms;

    assert.isTrue(pawnLoan.borrower.equals(borrower));
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
        lenderKeypair.publicKey,
        10_000_000_000
      ),
      "confirmed"
    );

    const pawnLoan = await program.account.pawnLoan.fetch(
      pawnLoanKeypair.publicKey
    );
    const pawnTokenAccount = findProgramAddressSync(
      [Buffer.from("pawn-token-account"), pawnLoanKeypair.publicKey.toBuffer()],
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
        pawnLoan: pawnLoanKeypair.publicKey,
        pawnTokenAccount,
        lender: lenderKeypair.publicKey,
        lenderPaymentAccount: lenderKeypair.publicKey,
        borrowerPaymentAccount: pawnLoan.borrower,
      })
      .signers([lenderKeypair])
      .rpc();

    const pawnLoanAfter = await program.account.pawnLoan.fetch(
      pawnLoanKeypair.publicKey
    );
    const terms = pawnLoanAfter.terms;

    assert.isTrue(
      terms?.principalAmount.eq(expectedDesiredTerms.principalAmount)
    );
    assert.isTrue(pawnLoanAfter.lender.equals(lenderKeypair.publicKey));
  });

  it("Repay Loan", async () => {
    // TODO
  });
});
