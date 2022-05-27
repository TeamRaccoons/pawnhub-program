import * as anchor from "@project-serum/anchor";
import { BN, Program, AnchorError } from "@project-serum/anchor";
import {
  NATIVE_MINT,
  Token,
  TOKEN_PROGRAM_ID,
  AccountInfo as TokenAccountInfo,
} from "@solana/spl-token";
import { assert } from "chai";
import { findProgramAddressSync } from "@project-serum/anchor/dist/cjs/utils/pubkey";
import { deserializeTokenAccountInfo } from "./utils";
import {
  LoanTerms,
  requestStandardLoan,
  underwriteLoan,
} from "./pawn-shop-sdk";
import { PawnShop } from "../target/types/pawn_shop";
import { PublicKey, Keypair, AccountInfo } from "@solana/web3.js";

const BORROWER_KEYPAIR = new Keypair();
const LENDER_KEYPAIR = new Keypair();
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_LOAN_AMOUNT = 10;

const TERMS_VALID: LoanTerms = {
  principalAmount: new BN(DEFAULT_LOAN_AMOUNT),
  mint: NATIVE_MINT,
  annualPercentageRateBps: new BN(10_000),
  duration: new BN(7 * MILLISECONDS_PER_DAY),
};

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
  let pawnMint: Token;
  let borrowerPawnTokenAccount: PublicKey;

  // For spl token loans
  let mintA: Token;
  let borrowerTokenAccountUsdc: PublicKey;
  let lenderTokenAccountUsdc: PublicKey;

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

    mintA = await Token.createMint(
      provider.connection,
      LENDER_KEYPAIR,
      LENDER_KEYPAIR.publicKey,
      null /** freeze authority */,
      0 /** decimals */,
      TOKEN_PROGRAM_ID
    );
    borrowerTokenAccountUsdc = await mintA.createAccount(
      BORROWER_KEYPAIR.publicKey
    );
    lenderTokenAccountUsdc = await mintA.createAccount(
      LENDER_KEYPAIR.publicKey
    );
    await mintA.mintTo(lenderTokenAccountUsdc, LENDER_KEYPAIR, [], 1_000_000);
  });

  // Reset default pawn loan before each test so that state is not dependent on other tests.
  beforeEach(async () => {
    pawnLoanKeypair = new Keypair();

    // Create mint and mint token
    pawnMint = await Token.createMint(
      provider.connection,
      BORROWER_KEYPAIR,
      BORROWER_KEYPAIR.publicKey,
      null /** freeze authority */,
      0 /** decimals */,
      TOKEN_PROGRAM_ID
    );

    borrowerPawnTokenAccount = await pawnMint.createAccount(
      BORROWER_KEYPAIR.publicKey
    );
    await pawnMint.mintTo(borrowerPawnTokenAccount, BORROWER_KEYPAIR, [], 1);
  });

  describe("Request Loan", () => {
    it("Saves terms in pawn loan account ", async () => {
      await requestStandardLoan(
        program,
        pawnLoanKeypair,
        BORROWER_KEYPAIR,
        pawnMint.publicKey,
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

    it("Moves NFT to program escrow", async () => {
      const pawnTokenAccount = findProgramAddressSync(
        [
          Buffer.from("pawn-token-account"),
          pawnLoanKeypair.publicKey.toBuffer(),
        ],
        program.programId
      )[0];

      const pawnTokenAccountInfo =
        await program.provider.connection.getAccountInfo(pawnTokenAccount);

      // Before: Mint is in borrower pawn token account.
      assert.strictEqual(
        await await (
          await pawnMint.getAccountInfo(borrowerPawnTokenAccount)
        ).amount.toNumber(),
        1
      );
      // Before: Pawn token account not created yet.
      assert.isNull(pawnTokenAccountInfo);

      await requestStandardLoan(
        program,
        pawnLoanKeypair,
        BORROWER_KEYPAIR,
        pawnMint.publicKey,
        borrowerPawnTokenAccount,
        TERMS_VALID
      );

      // After: Mint moved to program escrow.
      assert.strictEqual(
        await await (
          await pawnMint.getAccountInfo(pawnTokenAccount)
        ).amount.toNumber(),
        1
      );
    });

    it("Should throw if invalid principal requested", async () => {
      let termsInvalid = {} as LoanTerms;
      Object.assign(termsInvalid, TERMS_VALID);
      termsInvalid.principalAmount = new BN(0);

      await testInvalidTerms(
        program,
        pawnLoanKeypair,
        pawnMint,
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
        pawnMint,
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
        pawnMint,
        borrowerPawnTokenAccount,
        termsInvalid
      );
    });
  });

  describe("Underwrite Loan - in SOL", () => {
    let pawnLoan: any;
    let pawnTokenAccount: PublicKey;
    let pawnTokenAccountInfo: AccountInfo<Buffer> | null;

    let expectedDesiredTerms: LoanTerms;
    let expectedPawnMint: PublicKey | undefined;

    beforeEach(async () => {
      await requestStandardLoan(
        program,
        pawnLoanKeypair,
        BORROWER_KEYPAIR,
        pawnMint.publicKey,
        borrowerPawnTokenAccount,
        TERMS_VALID
      );
      pawnLoan = await program.account.pawnLoan.fetch(
        pawnLoanKeypair.publicKey
      );
      pawnTokenAccount = findProgramAddressSync(
        [
          Buffer.from("pawn-token-account"),
          pawnLoanKeypair.publicKey.toBuffer(),
        ],
        program.programId
      )[0];
      pawnTokenAccountInfo = await program.provider.connection.getAccountInfo(
        pawnTokenAccount
      );
      const decodedPawnTokenAccountInfo = deserializeTokenAccountInfo(
        pawnTokenAccountInfo?.data
      );
      expectedPawnMint = decodedPawnTokenAccountInfo?.mint;
      expectedDesiredTerms = pawnLoan.desiredTerms;
    });

    it("Sets terms for underwritten loan", async () => {
      await underwriteLoan(
        program,
        pawnLoan,
        pawnLoanKeypair,
        pawnTokenAccount,
        LENDER_KEYPAIR,
        LENDER_KEYPAIR.publicKey,
        BORROWER_KEYPAIR.publicKey
      );

      const pawnLoanAfter = await program.account.pawnLoan.fetch(
        pawnLoanKeypair.publicKey
      );
      const terms = pawnLoanAfter.terms;

      assert.isTrue(
        terms?.principalAmount.eq(expectedDesiredTerms.principalAmount)
      );
      assert.isTrue(pawnLoanAfter.lender.equals(LENDER_KEYPAIR.publicKey));
    });

    it("Transfers the loan amount from lender to the borrower -- in SOL", async () => {
      const borrowerBalanceBefore =
        await program.provider.connection.getBalance(pawnLoan.borrower);

      const lenderBalanceBefore = await program.provider.connection.getBalance(
        LENDER_KEYPAIR.publicKey
      );

      await underwriteLoan(
        program,
        pawnLoan,
        pawnLoanKeypair,
        pawnTokenAccount,
        LENDER_KEYPAIR,
        LENDER_KEYPAIR.publicKey,
        BORROWER_KEYPAIR.publicKey
      );

      const borrowerBalanceAfter = await program.provider.connection.getBalance(
        pawnLoan.borrower
      );
      const lenderBalanceAfter = await program.provider.connection.getBalance(
        LENDER_KEYPAIR.publicKey
      );
      assert.strictEqual(
        borrowerBalanceBefore + DEFAULT_LOAN_AMOUNT,
        borrowerBalanceAfter
      );
      assert.strictEqual(
        lenderBalanceBefore,
        lenderBalanceAfter + DEFAULT_LOAN_AMOUNT
      );
    });

    it("Throws error if loan status is not open", async () => {
      // This will move status from open to active.
      await underwriteLoan(
        program,
        pawnLoan,
        pawnLoanKeypair,
        pawnTokenAccount,
        LENDER_KEYPAIR,
        LENDER_KEYPAIR.publicKey,
        BORROWER_KEYPAIR.publicKey
      );

      try {
        await underwriteLoan(
          program,
          pawnLoan,
          pawnLoanKeypair,
          pawnTokenAccount,
          LENDER_KEYPAIR,
          LENDER_KEYPAIR.publicKey,
          BORROWER_KEYPAIR.publicKey
        );
        assert.ok(false);
      } catch (e) {
        let err = e as AnchorError;
        assert.strictEqual(err.error.errorMessage, "InvalidLoanStatus");
      }
    });

    it("Throws error if desired loan terms not matched", async () => {
      let badDesiredTerms = expectedDesiredTerms;
      badDesiredTerms.principalAmount = new BN(500);

      assert.isNotNull(expectedPawnMint);
      if (!expectedPawnMint) {
        return;
      }

      try {
        await program.methods
          .underwriteLoan(expectedDesiredTerms, expectedPawnMint, new BN(1))
          .accounts({
            pawnLoan: pawnLoanKeypair.publicKey,
            pawnTokenAccount,
            lender: LENDER_KEYPAIR.publicKey,
            lenderPaymentAccount: LENDER_KEYPAIR.publicKey,
            borrowerPaymentAccount: BORROWER_KEYPAIR.publicKey,
          })
          .signers([LENDER_KEYPAIR])
          .rpc();
        assert.ok(false);
      } catch (e) {
        const err = e as AnchorError;
        assert.strictEqual(err.error.errorMessage, "UnexpectedDesiredTerms");
      }
    });

    it("Throws error if desired loan mint not matched", async () => {
      try {
        await program.methods
          .underwriteLoan(expectedDesiredTerms, mintA.publicKey, new BN(1))
          .accounts({
            pawnLoan: pawnLoanKeypair.publicKey,
            pawnTokenAccount,
            lender: LENDER_KEYPAIR.publicKey,
            lenderPaymentAccount: LENDER_KEYPAIR.publicKey,
            borrowerPaymentAccount: BORROWER_KEYPAIR.publicKey,
          })
          .signers([LENDER_KEYPAIR])
          .rpc();
        assert.ok(false);
      } catch (e) {
        const err = e as AnchorError;
        assert.strictEqual(err.error.errorMessage, "UnexpectedPawnMint");
      }
    });

    it("Throws error if desired loan amount not matched", async () => {
      assert.isNotNull(expectedPawnMint);
      if (!expectedPawnMint) {
        return;
      }

      try {
        await program.methods
          .underwriteLoan(expectedDesiredTerms, expectedPawnMint, new BN(100))
          .accounts({
            pawnLoan: pawnLoanKeypair.publicKey,
            pawnTokenAccount,
            lender: LENDER_KEYPAIR.publicKey,
            lenderPaymentAccount: LENDER_KEYPAIR.publicKey,
            borrowerPaymentAccount: BORROWER_KEYPAIR.publicKey,
          })
          .signers([LENDER_KEYPAIR])
          .rpc();
        assert.ok(false);
      } catch (e) {
        const err = e as AnchorError;
        assert.strictEqual(err.error.errorMessage, "UnexpectedPawnAmount");
      }
    });
  });

  describe("Underwrite Loan - in SPL Token", () => {
    let pawnLoan: any;
    let pawnTokenAccount: PublicKey;

    beforeEach(async () => {
      const termsUsdc: LoanTerms = {
        principalAmount: new BN(DEFAULT_LOAN_AMOUNT),
        mint: mintA.publicKey,
        annualPercentageRateBps: new BN(10_000),
        duration: new BN(7 * MILLISECONDS_PER_DAY),
      };

      await requestStandardLoan(
        program,
        pawnLoanKeypair,
        BORROWER_KEYPAIR,
        pawnMint.publicKey,
        borrowerPawnTokenAccount,
        termsUsdc
      );

      pawnLoan = await program.account.pawnLoan.fetch(
        pawnLoanKeypair.publicKey
      );
      pawnTokenAccount = findProgramAddressSync(
        [
          Buffer.from("pawn-token-account"),
          pawnLoanKeypair.publicKey.toBuffer(),
        ],
        program.programId
      )[0];
    });

    it("Transfers the loan amount from lender to the borrower -- in SPL token", async () => {
      const borrowerBalanceBefore = (
        await program.provider.connection.getTokenAccountBalance(
          borrowerTokenAccountUsdc
        )
      ).value.uiAmount;
      const lenderBalanceBefore = (
        await program.provider.connection.getTokenAccountBalance(
          lenderTokenAccountUsdc
        )
      ).value.uiAmount;

      await underwriteLoan(
        program,
        pawnLoan,
        pawnLoanKeypair,
        pawnTokenAccount,
        LENDER_KEYPAIR,
        lenderTokenAccountUsdc,
        borrowerTokenAccountUsdc
      );

      const borrowerBalanceAfter = (
        await program.provider.connection.getTokenAccountBalance(
          borrowerTokenAccountUsdc
        )
      ).value.uiAmount;
      const lenderBalanceAfter = (
        await program.provider.connection.getTokenAccountBalance(
          lenderTokenAccountUsdc
        )
      ).value.uiAmount;

      // To silence typescript null warning
      if (borrowerBalanceBefore === null || lenderBalanceAfter == null) {
        assert.ok(false);
        return;
      }

      assert.strictEqual(
        borrowerBalanceBefore + DEFAULT_LOAN_AMOUNT,
        borrowerBalanceAfter
      );
      assert.strictEqual(
        lenderBalanceBefore,
        lenderBalanceAfter + DEFAULT_LOAN_AMOUNT
      );
    });
  });

  describe("Repay Loan", () => {
    let pawnLoan: any;
    let pawnTokenAccount: PublicKey;

    beforeEach(async () => {
      await requestStandardLoan(
        program,
        pawnLoanKeypair,
        BORROWER_KEYPAIR,
        pawnMint.publicKey,
        borrowerPawnTokenAccount,
        TERMS_VALID
      );

      pawnLoan = await program.account.pawnLoan.fetch(
        pawnLoanKeypair.publicKey
      );
      pawnTokenAccount = findProgramAddressSync(
        [
          Buffer.from("pawn-token-account"),
          pawnLoanKeypair.publicKey.toBuffer(),
        ],
        program.programId
      )[0];

      await underwriteLoan(
        program,
        pawnLoan,
        pawnLoanKeypair,
        pawnTokenAccount,
        LENDER_KEYPAIR,
        LENDER_KEYPAIR.publicKey,
        BORROWER_KEYPAIR.publicKey
      );
    });

    it.skip("Repays loan amount plus interest from borrower to lender", async () => {});
    it.skip("Transfers platform fee to admin", async () => {});
    it.skip("Throws error if non-borrower tries to repay", async () => {});
    it.skip("Throws error if amount less than due is repaid", async () => {});
  });

  describe("Seize Pawn", () => {
    it.skip("should not be seizable when not due", async () => {});
    it.skip("should transfer pawn to lender when seized", async () => {});
    it.skip("platform fee is received", async () => {});
  });

  describe("Cancel Loan", () => {
    it.skip("should close the account", async () => {});
    it("Cancel loan", async () => {
      const { pawnTokenAccount } = await requestStandardLoan(
        program,
        pawnLoanKeypair,
        BORROWER_KEYPAIR,
        pawnMint.publicKey,
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

async function testInvalidTerms(
  program: Program<PawnShop>,
  pawnLoanKeypair: Keypair,
  pawnMint: Token,
  borrowerPawnTokenAccount: PublicKey,
  termsInvalid: LoanTerms
) {
  try {
    await requestStandardLoan(
      program,
      pawnLoanKeypair,
      BORROWER_KEYPAIR,
      pawnMint.publicKey,
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
