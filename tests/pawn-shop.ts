import * as anchor from "@project-serum/anchor";
import { BN, Program, AnchorError } from "@project-serum/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  Token,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";
import { findProgramAddressSync } from "@project-serum/anchor/dist/cjs/utils/pubkey";
import {
  delay,
  deserializeTokenAccountInfo,
  getBorrowerAndLenderSolBalance,
  getBorrowerAndLenderTokenBalance,
} from "./utils";
import {
  LoanTerms,
  repayLoanInSol,
  repayLoan,
  requestLoan,
  seizePawn,
  underwriteLoan,
} from "./pawn-shop-sdk";
import { PawnShop } from "../target/types/pawn_shop";
import {
  PublicKey,
  Keypair,
  AccountInfo,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";

const BORROWER_KEYPAIR = new Keypair();
const LENDER_KEYPAIR = new Keypair();
const FEE_COLLECTOR_KEYPAIR = Keypair.fromSecretKey(
  new Uint8Array([
    209, 175, 187, 249, 146, 53, 247, 243, 119, 89, 121, 250, 200, 88, 179, 144,
    250, 142, 10, 222, 205, 72, 101, 132, 172, 130, 12, 20, 182, 51, 183, 87,
    243, 80, 232, 164, 235, 60, 37, 162, 152, 106, 77, 43, 54, 241, 153, 165,
    114, 165, 159, 217, 125, 225, 74, 243, 131, 193, 224, 180, 14, 15, 8, 20,
  ])
);
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_LOAN_AMOUNT = 10;

const TERMS_VALID: LoanTerms = {
  principalAmount: new BN(DEFAULT_LOAN_AMOUNT),
  mint: NATIVE_MINT,
  annualPercentageRateBps: new BN(1_000), // 10%
  duration: new BN(7 * MILLISECONDS_PER_DAY),
};

const TERMS_SUPER_SHORT_LOAN: LoanTerms = {
  principalAmount: new BN(DEFAULT_LOAN_AMOUNT),
  mint: NATIVE_MINT,
  annualPercentageRateBps: new BN(1_000), // 10%
  duration: new BN(1),
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
  const ADMIN_PDA: PublicKey = findProgramAddressSync(
    [Buffer.from("admin")],
    program.programId
  )[0];

  // New ones are assigned before each test with "beforeEach" hook.
  let pawnLoanKeypair: Keypair;
  let pawnMint: Token;
  let borrowerPawnTokenAccount: PublicKey;
  let lenderPawnTokenAccount: PublicKey;

  // For spl token loans
  let mintA: Token;
  let borrowerMintATokenAccount: PublicKey;
  let lenderMintATokenAccount: PublicKey;
  let adminMintATokenAccount: PublicKey;
  let termsUsdc: LoanTerms;

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
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(ADMIN_PDA, 1_000_000_000),
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
    borrowerMintATokenAccount = await mintA.createAccount(
      BORROWER_KEYPAIR.publicKey
    );
    lenderMintATokenAccount = await mintA.createAccount(
      LENDER_KEYPAIR.publicKey
    );
    adminMintATokenAccount = await mintA.createAccount(ADMIN_PDA);

    await mintA.mintTo(lenderMintATokenAccount, LENDER_KEYPAIR, [], 1_000_000);
    await mintA.mintTo(
      borrowerMintATokenAccount,
      LENDER_KEYPAIR,
      [],
      1_000_000
    );

    termsUsdc = {
      principalAmount: new BN(DEFAULT_LOAN_AMOUNT),
      mint: mintA.publicKey,
      annualPercentageRateBps: new BN(1_000),
      duration: new BN(7 * MILLISECONDS_PER_DAY),
    };
  });

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
    lenderPawnTokenAccount = await pawnMint.createAccount(
      LENDER_KEYPAIR.publicKey
    );
    await pawnMint.mintTo(borrowerPawnTokenAccount, BORROWER_KEYPAIR, [], 1);
  });

  describe("Request Loan", () => {
    it("Saves terms in pawn loan account ", async () => {
      await requestLoan(
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
        (
          await pawnMint.getAccountInfo(borrowerPawnTokenAccount)
        ).amount.toNumber(),
        1
      );
      // Before: Pawn token account not created yet.
      assert.isNull(pawnTokenAccountInfo);

      await requestLoan(
        program,
        pawnLoanKeypair,
        BORROWER_KEYPAIR,
        pawnMint.publicKey,
        borrowerPawnTokenAccount,
        TERMS_VALID
      );

      // After: Mint moved to program escrow.
      assert.strictEqual(
        (await pawnMint.getAccountInfo(pawnTokenAccount)).amount.toNumber(),
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
      ({ pawnTokenAccount } = await requestLoan(
        program,
        pawnLoanKeypair,
        BORROWER_KEYPAIR,
        pawnMint.publicKey,
        borrowerPawnTokenAccount,
        TERMS_VALID
      ));

      pawnLoan = await program.account.pawnLoan.fetch(
        pawnLoanKeypair.publicKey
      );

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
      const [borrowerBalanceBefore, lenderBalanceBefore] =
        await getBorrowerAndLenderSolBalance(
          program,
          pawnLoan.borrower,
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

      const [borrowerBalanceAfter, lenderBalanceAfter] =
        await getBorrowerAndLenderSolBalance(
          program,
          pawnLoan.borrower,
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
      ({ pawnTokenAccount } = await requestLoan(
        program,
        pawnLoanKeypair,
        BORROWER_KEYPAIR,
        pawnMint.publicKey,
        borrowerPawnTokenAccount,
        termsUsdc
      ));

      pawnLoan = await program.account.pawnLoan.fetch(
        pawnLoanKeypair.publicKey
      );
    });

    it("Transfers the loan amount from lender to the borrower -- in SPL token", async () => {
      const [borrowerBalanceBefore, lenderBalanceBefore] =
        await getBorrowerAndLenderTokenBalance(
          program,
          borrowerMintATokenAccount,
          lenderMintATokenAccount
        );

      await underwriteLoan(
        program,
        pawnLoan,
        pawnLoanKeypair,
        pawnTokenAccount,
        LENDER_KEYPAIR,
        lenderMintATokenAccount,
        borrowerMintATokenAccount
      );

      const [borrowerBalanceAfter, lenderBalanceAfter] =
        await getBorrowerAndLenderTokenBalance(
          program,
          borrowerMintATokenAccount,
          lenderMintATokenAccount
        );

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

  describe("Repay Loan - in SOL", () => {
    let pawnLoan: any;
    let pawnTokenAccount: PublicKey;

    beforeEach(async () => {
      ({ pawnTokenAccount } = await requestLoan(
        program,
        pawnLoanKeypair,
        BORROWER_KEYPAIR,
        pawnMint.publicKey,
        borrowerPawnTokenAccount,
        TERMS_VALID
      ));

      pawnLoan = await program.account.pawnLoan.fetch(
        pawnLoanKeypair.publicKey
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
    });

    it("Repays loan amount from borrower to lender -- in SOL", async () => {
      const [borrowerBalanceBefore, lenderBalanceBefore] =
        await getBorrowerAndLenderSolBalance(
          program,
          BORROWER_KEYPAIR.publicKey,
          LENDER_KEYPAIR.publicKey
        );

      await repayLoanInSol(
        program,
        pawnLoanKeypair,
        pawnTokenAccount,
        BORROWER_KEYPAIR,
        borrowerPawnTokenAccount,
        LENDER_KEYPAIR.publicKey,
        ADMIN_PDA
      );

      const [borrowerBalanceAfter, lenderBalanceAfter] =
        await getBorrowerAndLenderSolBalance(
          program,
          BORROWER_KEYPAIR.publicKey,
          LENDER_KEYPAIR.publicKey
        );

      // To silence typescript null warning
      if (borrowerBalanceBefore === null || lenderBalanceAfter == null) {
        assert.ok(false);
        return;
      }

      assert.strictEqual(
        borrowerBalanceBefore - borrowerBalanceAfter,
        lenderBalanceAfter - lenderBalanceBefore
      );
    });

    it("Throws error if non-borrower tries to repay", async () => {
      try {
        await repayLoanInSol(
          program,
          pawnLoanKeypair,
          pawnTokenAccount,
          LENDER_KEYPAIR,
          borrowerPawnTokenAccount,
          LENDER_KEYPAIR.publicKey,
          ADMIN_PDA
        );
        assert.ok(false);
      } catch (_err) {
        assert.isTrue(_err instanceof AnchorError);
        const err = _err as AnchorError;
        assert.strictEqual(err.error.errorCode.number, 2001);
        assert.strictEqual(
          err.error.errorMessage,
          "A has one constraint was violated"
        );
      }
    });

    it("Throws if repayment happens when loan is not active", async () => {
      // Status moves from active to repaid
      await repayLoanInSol(
        program,
        pawnLoanKeypair,
        pawnTokenAccount,
        BORROWER_KEYPAIR,
        borrowerPawnTokenAccount,
        LENDER_KEYPAIR.publicKey,
        ADMIN_PDA
      );
      try {
        await repayLoanInSol(
          program,
          pawnLoanKeypair,
          pawnTokenAccount,
          BORROWER_KEYPAIR,
          borrowerPawnTokenAccount,
          LENDER_KEYPAIR.publicKey,
          ADMIN_PDA
        );
        assert.ok(false);
      } catch (_err) {
        assert.isTrue(_err instanceof AnchorError);
        const err = _err as AnchorError;
        assert.strictEqual(err.error.errorCode.number, 6003);
        assert.strictEqual(err.error.errorMessage, "InvalidLoanStatus");
      }
    });
  });

  describe("Repay Loan - in SPL Token", () => {
    let pawnLoan: any;
    let pawnTokenAccount: PublicKey;

    beforeEach(async () => {
      ({ pawnTokenAccount } = await requestLoan(
        program,
        pawnLoanKeypair,
        BORROWER_KEYPAIR,
        pawnMint.publicKey,
        borrowerPawnTokenAccount,
        termsUsdc
      ));

      pawnLoan = await program.account.pawnLoan.fetch(
        pawnLoanKeypair.publicKey
      );

      await underwriteLoan(
        program,
        pawnLoan,
        pawnLoanKeypair,
        pawnTokenAccount,
        LENDER_KEYPAIR,
        lenderMintATokenAccount,
        borrowerMintATokenAccount
      );
    });

    it("Repays loan amount from borrower to lender -- in SPL Token", async () => {
      const [borrowerBalanceBefore, lenderBalanceBefore] =
        await getBorrowerAndLenderTokenBalance(
          program,
          borrowerMintATokenAccount,
          lenderMintATokenAccount
        );

      await repayLoan(
        program,
        pawnLoanKeypair,
        pawnTokenAccount,
        BORROWER_KEYPAIR,
        borrowerMintATokenAccount,
        borrowerPawnTokenAccount,
        lenderMintATokenAccount,
        ADMIN_PDA,
        adminMintATokenAccount
      );
      const [borrowerBalanceAfter, lenderBalanceAfter] =
        await getBorrowerAndLenderTokenBalance(
          program,
          borrowerMintATokenAccount,
          lenderMintATokenAccount
        );
      // To silence typescript null warning
      if (
        borrowerBalanceBefore === null ||
        borrowerBalanceAfter === null ||
        lenderBalanceBefore === null ||
        lenderBalanceAfter === null
      ) {
        assert.ok(false);
        return;
      }
      assert.strictEqual(
        borrowerBalanceBefore - borrowerBalanceAfter,
        lenderBalanceAfter - lenderBalanceBefore
      );
    });
  });

  describe("Seize Pawn", () => {
    let pawnLoan: any;
    let pawnTokenAccount: PublicKey;

    beforeEach(async () => {
      ({ pawnTokenAccount } = await requestLoan(
        program,
        pawnLoanKeypair,
        BORROWER_KEYPAIR,
        pawnMint.publicKey,
        borrowerPawnTokenAccount,
        TERMS_SUPER_SHORT_LOAN
      ));

      pawnLoan = await program.account.pawnLoan.fetch(
        pawnLoanKeypair.publicKey
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
    });

    it("Throws error if attempt to seize before due", async () => {
      try {
        await seizePawn(
          program,
          pawnLoanKeypair.publicKey,
          pawnTokenAccount,
          LENDER_KEYPAIR,
          lenderPawnTokenAccount
        );
        assert.ok(false);
      } catch (_err) {
        assert.isTrue(_err instanceof AnchorError);
        const err = _err as AnchorError;
        assert.strictEqual(err.error.errorCode.number, 6008);
        assert.strictEqual(err.error.errorMessage, "CannotSeizeBeforeExpiry");
      }
    });

    it("Seizing should update status and transfer mint to lender", async () => {
      await delay(2000);
      await seizePawn(
        program,
        pawnLoanKeypair.publicKey,
        pawnTokenAccount,
        LENDER_KEYPAIR,
        lenderPawnTokenAccount
      );
      const pawnLoan = await program.account.pawnLoan.fetch(
        pawnLoanKeypair.publicKey
      );

      // Unsure why pawnLoan status enum shows up as {defaulted: {}}
      assert.strictEqual(Object.keys(pawnLoan.status)[0], "defaulted");

      const lenderPawnTokenAccountInfo =
        await program.provider.connection.getAccountInfo(
          lenderPawnTokenAccount
        );

      const decodedlenderPawnTokenAccountInfo = deserializeTokenAccountInfo(
        lenderPawnTokenAccountInfo?.data
      );
      if (!pawnLoan.terms?.mint) {
        assert.ok(false);
        return;
      }
      // Pawn mint transferred to lender account
      assert.isTrue(
        decodedlenderPawnTokenAccountInfo?.mint.equals(pawnMint.publicKey)
      );
      assert.strictEqual(
        decodedlenderPawnTokenAccountInfo?.amount.toNumber(),
        1
      );
    });
  });

  describe("Cancel Loan", () => {
    it("Cancel loan", async () => {
      const { pawnTokenAccount } = await requestLoan(
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

  describe("Withdraw admin fees", () => {
    before(async () => {
      // Tests above happen sequentially and don't accumulate any admin fee
      await mintA.mintTo(adminMintATokenAccount, LENDER_KEYPAIR, [], 1_000_000);
    });

    it("Can withdraw - in SOL", async () => {
      const beforeAdminAccountInfo =
        await program.provider.connection.getAccountInfo(ADMIN_PDA);
      if (!beforeAdminAccountInfo) {
        assert.isNotNull(beforeAdminAccountInfo);
        return;
      }

      await program.methods
        .withdrawAdminFees()
        .accounts({
          feeCollector: FEE_COLLECTOR_KEYPAIR.publicKey,
          feeCollectorPaymentAccount: FEE_COLLECTOR_KEYPAIR.publicKey,
          admin: ADMIN_PDA,
          adminPaymentAccount: ADMIN_PDA,
        })
        .signers([FEE_COLLECTOR_KEYPAIR])
        .rpc();

      // Admin should be left rent exempt
      const afterAdminAccountInfo =
        await program.provider.connection.getAccountInfo(ADMIN_PDA);
      if (!afterAdminAccountInfo) {
        assert.isNotNull(afterAdminAccountInfo);
        return;
      }
      const rentExemptThreshold =
        await provider.connection.getMinimumBalanceForRentExemption(
          afterAdminAccountInfo.data.length
        );
      assert.isTrue(afterAdminAccountInfo.lamports === rentExemptThreshold);

      // fee collector received the SOL
      const feeCollectorAccountInfo =
        await program.provider.connection.getAccountInfo(
          FEE_COLLECTOR_KEYPAIR.publicKey
        );
      const expectedLamports =
        beforeAdminAccountInfo.lamports - afterAdminAccountInfo.lamports;
      assert.isTrue(feeCollectorAccountInfo?.lamports === expectedLamports);
    });

    it("Can withdraw - in SPL tokens", async () => {
      const feeCollectorPaymentAccount = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        mintA.publicKey,
        FEE_COLLECTOR_KEYPAIR.publicKey
      );

      const adminMintATokenAccountInfo =
        await program.provider.connection.getAccountInfo(
          adminMintATokenAccount
        );

      const decodedAdminMintATokenAccountInfo = deserializeTokenAccountInfo(
        adminMintATokenAccountInfo?.data
      );
      const availableAdminMintAFees = decodedAdminMintATokenAccountInfo?.amount;
      if (!availableAdminMintAFees || availableAdminMintAFees.eq(new BN(0))) {
        assert.ok(
          false,
          `availableAdminMintAFees cannot be null or zero but was: ${availableAdminMintAFees}`
        );
        return;
      }

      await program.methods
        .withdrawAdminFees()
        .accounts({
          feeCollector: FEE_COLLECTOR_KEYPAIR.publicKey,
          feeCollectorPaymentAccount,
          admin: ADMIN_PDA,
          adminPaymentAccount: adminMintATokenAccount,
        })
        .preInstructions([
          Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            mintA.publicKey,
            feeCollectorPaymentAccount,
            FEE_COLLECTOR_KEYPAIR.publicKey,
            provider.wallet.publicKey
          ),
        ])
        .signers([FEE_COLLECTOR_KEYPAIR])
        .rpc();

      const feeCollectorPaymentAccountInfo =
        await program.provider.connection.getAccountInfo(
          feeCollectorPaymentAccount
        );

      const decodedFeeCollectorTokenAccount = deserializeTokenAccountInfo(
        feeCollectorPaymentAccountInfo?.data
      );
      assert.isTrue(
        decodedFeeCollectorTokenAccount?.amount.eq(availableAdminMintAFees)
      );
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
    await requestLoan(
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
