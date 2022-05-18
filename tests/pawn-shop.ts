import * as anchor from "@project-serum/anchor";
import {
  AnchorError,
  BN,
  IdlAccounts,
  IdlTypes,
  Program,
} from "@project-serum/anchor";
import { findProgramAddressSync } from "@project-serum/anchor/dist/cjs/utils/pubkey";
import { NATIVE_MINT, Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";
import { PawnShop } from "../target/types/pawn_shop";
import { deserializeTokenAccountInfo } from "./utils";
import { PublicKey, Keypair } from "@solana/web3.js";
import fs from "fs";

// Hack to prune events from the idl to prevent deserialization bug (account struct is not a defined type)
const pawnShopIdl = JSON.parse(
  fs.readFileSync("./target/idl/pawn_shop.json", "utf8")
);
delete pawnShopIdl["events"];
fs.writeFileSync("./target/idl/pawn_shop.json", JSON.stringify(pawnShopIdl));

const BORROWER_KEYPAIR = new Keypair();
const LENDER_KEYPAIR = new Keypair();
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const TERMS_VALID: LoanTerms = {
  principalAmount: new BN(10),
  mint: NATIVE_MINT,
  annualPercentageRateBps: new BN(10_000),
  duration: new BN(7 * MILLISECONDS_PER_DAY),
};

export type PawnLoan = Omit<
  IdlAccounts<PawnShop>["pawnLoan"],
  "desiredTerms" | "terms"
> & {
  desiredTerms: LoanTerms | null;
  terms: LoanTerms | null;
};
export type LoanTerms = IdlTypes<PawnShop>["LoanTerms"];

describe("PawnHub", () => {
  // Configure the client to use the local cluster.
  const anchorProvider = anchor.Provider.env();
  anchorProvider.opts.skipPreflight = true;
  anchorProvider.opts.commitment = "confirmed";
  anchor.setProvider(anchorProvider);
  const program: Program<PawnShop> = anchor.workspace
    .PawnShop as Program<PawnShop>;
  const provider: anchor.Provider = program.provider;

  // New ones are assigned before each test with "beforeEach" hook.
  let pawnLoanKeypair: Keypair;
  let mintA: Token;
  let borrowerPawnTokenAccount: PublicKey;

  // Use same program and airdrop once globally.
  before(async () => {
    // Make default borrower and lender rich.
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        BORROWER_KEYPAIR.publicKey,
        10_000_000_000
      ),
      "confirmed"
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        LENDER_KEYPAIR.publicKey,
        10_000_000_000
      ),
      "confirmed"
    );
  });

  // Reset default pawn loan before each test so that state is not dependent on other tests.
  beforeEach(async () => {
    pawnLoanKeypair = new Keypair();

    // Create mint and mint token
    mintA = await Token.createMint(
      provider.connection,
      BORROWER_KEYPAIR,
      BORROWER_KEYPAIR.publicKey,
      null /** freeze authority */,
      0 /** decimals */,
      TOKEN_PROGRAM_ID
    );

    borrowerPawnTokenAccount = await mintA.createAccount(
      BORROWER_KEYPAIR.publicKey
    );
    await mintA.mintTo(borrowerPawnTokenAccount, BORROWER_KEYPAIR, [], 1);
  });

  describe("Request Loan", () => {
    it("Saves terms in pawn loan account ", async () => {
      await requestLoan(
        program,
        pawnLoanKeypair,
        BORROWER_KEYPAIR,
        mintA.publicKey,
        borrowerPawnTokenAccount,
        TERMS_VALID
      );

      const pawnLoan = await program.account.pawnLoan.fetch(
        pawnLoanKeypair.publicKey
      );
      const desiredTerms = pawnLoan.desiredTerms;

      assert.isTrue(pawnLoan.borrower.equals(BORROWER_KEYPAIR.publicKey));
      assert.isTrue(
        desiredTerms?.principalAmount.eq(TERMS_VALID.principalAmount)
      );
      assert.isTrue(desiredTerms?.mint.equals(TERMS_VALID.mint));
      assert.isTrue(
        desiredTerms?.annualPercentageRateBps.eq(
          TERMS_VALID.annualPercentageRateBps
        )
      );
      assert.isTrue(desiredTerms?.duration.eq(TERMS_VALID.duration));
      // These terms are only set when the loan is underwritten.
      assert.isNull(pawnLoan.terms);
    });

    it("Should throw if invalid principal requested", async () => {
      let termsInvalid = {} as LoanTerms;
      Object.assign(termsInvalid, TERMS_VALID);
      termsInvalid.principalAmount = new BN(0);

      await testInvalidTerms(
        program,
        pawnLoanKeypair,
        mintA,
        borrowerPawnTokenAccount,
        termsInvalid
      );
    });

    it("Should throw if invalid APR requested", async () => {
      let termsInvalid = {} as LoanTerms;
      Object.assign(termsInvalid, TERMS_VALID);
      termsInvalid.annualPercentageRateBps = new BN(0);

      await testInvalidTerms(
        program,
        pawnLoanKeypair,
        mintA,
        borrowerPawnTokenAccount,
        termsInvalid
      );
    });

    it("Should throw if invalid duration requested", async () => {
      let termsInvalid = {} as LoanTerms;
      Object.assign(termsInvalid, TERMS_VALID);
      termsInvalid.duration = new BN(0);

      await testInvalidTerms(
        program,
        pawnLoanKeypair,
        mintA,
        borrowerPawnTokenAccount,
        termsInvalid
      );
    });

    // it("Moves NFT to program escrow", async () => {
    // });
  });

  describe("Underwrite Loan", () => {
    beforeEach(async () => {
      await requestLoan(
        program,
        pawnLoanKeypair,
        BORROWER_KEYPAIR,
        mintA.publicKey,
        borrowerPawnTokenAccount,
        TERMS_VALID
      );
    });
    it("Underwrite Loan", async () => {
      const pawnLoan = await program.account.pawnLoan.fetch(
        pawnLoanKeypair.publicKey
      );
      const pawnTokenAccount = findProgramAddressSync(
        [
          Buffer.from("pawn-token-account"),
          pawnLoanKeypair.publicKey.toBuffer(),
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
          pawnLoan: pawnLoanKeypair.publicKey,
          pawnTokenAccount,
          lender: LENDER_KEYPAIR.publicKey,
          lenderPaymentAccount: LENDER_KEYPAIR.publicKey,
          borrowerPaymentAccount: pawnLoan.borrower,
        })
        .signers([LENDER_KEYPAIR])
        .rpc();

      const pawnLoanAfter = await program.account.pawnLoan.fetch(
        pawnLoanKeypair.publicKey
      );
      const terms = pawnLoanAfter.terms;

      assert.isTrue(
        terms?.principalAmount.eq(expectedDesiredTerms.principalAmount)
      );
      assert.isTrue(pawnLoanAfter.lender.equals(LENDER_KEYPAIR.publicKey));
    });
  });

  describe("Repay Loan", () => {
    it("Repay Loan", async () => {
      // TODO
    });
  });

  describe("Cancel Loan", () => {
    it("Cancel loan", async () => {
      const { pawnTokenAccount } = await requestLoan(
        program,
        pawnLoanKeypair,
        BORROWER_KEYPAIR,
        mintA.publicKey,
        borrowerPawnTokenAccount,
        TERMS_VALID
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
});

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

async function testInvalidTerms(
  program: Program<PawnShop>,
  pawnLoanKeypair: Keypair,
  mintA: Token,
  borrowerPawnTokenAccount: PublicKey,
  termsInvalid: LoanTerms
) {
  try {
    await requestLoan(
      program,
      pawnLoanKeypair,
      BORROWER_KEYPAIR,
      mintA.publicKey,
      borrowerPawnTokenAccount,
      termsInvalid
    );
    assert.ok(false);
  } catch (_err) {
    assert.isTrue(_err instanceof AnchorError);
    const err = _err as AnchorError;
    assert.strictEqual(err.error.errorCode.number, 6001);
    assert.strictEqual(err.error.errorMessage, "InvalidLoanTerms");
  }
}
