import * as anchor from "@project-serum/anchor";
import { AnchorError, BN, Program } from "@project-serum/anchor";
import { set } from "@project-serum/anchor/dist/cjs/utils/features";
import { findProgramAddressSync } from "@project-serum/anchor/dist/cjs/utils/pubkey";
import { TOKEN_PROGRAM_ID } from "@project-serum/anchor/dist/cjs/utils/token";
import { Token } from "@solana/spl-token";
import { assert } from "chai";
import { PawnShop } from "../target/types/pawn_shop";

const {
  Keypair,
  PublicKey,
  // SystemProgram,
  // Transaction,
  // sendAndConfirmTransaction,
} = anchor.web3;

const payerKeypair = new Keypair();
const pawnLoanKeypair = new Keypair();
const lenderKeypair = new Keypair();
const secondLenderKeypair = new Keypair();

describe("pawn-shop", () => {
  // Configure the client to use the local cluster.
  const anchorProvider = anchor.Provider.env();
  anchorProvider.opts.skipPreflight = true;
  anchorProvider.opts.commitment = "confirmed";
  anchor.setProvider(anchorProvider);
  // set("debug-logs");

  const program = anchor.workspace.PawnShop as Program<PawnShop>;

  it("Create loan", async () => {
    const provider = program.provider;
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        payerKeypair.publicKey,
        10_000_000_000
      ),
      "confirmed"
    );

    const owner = provider.wallet.publicKey;

    // Create mint and mint token
    const mintA = await Token.createMint(
      provider.connection,
      payerKeypair,
      payerKeypair.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    const ownerTokenAccount = await mintA.createAccount(owner);

    await mintA.mintTo(ownerTokenAccount, payerKeypair, [], 1);

    const amount = new BN(1);
    const interestRate = new BN(10_000);
    const maxLoanAmount = new BN(12345789);

    const time = await provider.connection.getBlockTime(
      await provider.connection.getSlot()
    );
    const loanCompleteTime = new BN(time + 1000);

    const pawnTokenAccount = findProgramAddressSync(
      [Buffer.from("pawn-token-account"), pawnLoanKeypair.publicKey.toBuffer()],
      program.programId
    )[0];

    const tx = await program.methods
      .createLoan(amount, interestRate, maxLoanAmount, loanCompleteTime)
      .accounts({
        pawnLoan: pawnLoanKeypair.publicKey,
        pawnTokenAccount,
        ownerTokenAccount,
        mint: mintA.publicKey,
        owner,
      })
      .signers([pawnLoanKeypair])
      .rpc();

    const pawnLoan = await program.account.pawnLoan.fetch(
      pawnLoanKeypair.publicKey
    );
    assert.isTrue(pawnLoan.owner.equals(owner));
    assert.isTrue(pawnLoan.interestRate.eq(interestRate));
    assert.isTrue(pawnLoan.maxLoanAmount.eq(maxLoanAmount));
    assert.isTrue(pawnLoan.pawnTokenAccount.equals(pawnTokenAccount));
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

    const loanAmount = new BN(1234);

    const tx = await program.methods
      .underwriteLoan(loanAmount)
      .accounts({
        pawnLoan: pawnLoanKeypair.publicKey,
        newLender: lenderKeypair.publicKey,
        lender: lenderKeypair.publicKey,
      })
      .signers([lenderKeypair])
      .rpc();

    const pawnLoan = await program.account.pawnLoan.fetch(
      pawnLoanKeypair.publicKey
    );
    assert.isTrue(pawnLoan.loanAmount.eq(loanAmount));
    assert.isTrue(pawnLoan.lender.equals(lenderKeypair.publicKey));
  });

  it("Draw Loan", async () => {
    // TODO
  });

  it("Underwrite Loan second lender", async () => {
    const provider = program.provider;

    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        secondLenderKeypair.publicKey,
        10_000_000_000
      ),
      "confirmed"
    );

    let { loanAmount, lender } = await program.account.pawnLoan.fetch(
      pawnLoanKeypair.publicKey
    );

    // Not enough for a bid payout
    try {
      const tx1 = await program.methods
        .underwriteLoan(loanAmount.subn(1_000))
        .accounts({
          pawnLoan: pawnLoanKeypair.publicKey,
          newLender: secondLenderKeypair.publicKey,
          lender: lenderKeypair.publicKey,
        })
        .signers([secondLenderKeypair])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      assert.ok(false);
    } catch (_err) {
      assert.isTrue(_err instanceof AnchorError);
      const err = _err as AnchorError;
      assert.strictEqual(
        err.error.errorCode.code,
        "CannotUnderwriteLessThanTopLender"
      );
    }

    const tx2 = await program.methods
      .underwriteLoan(loanAmount.addn(10_000_000))
      .accounts({
        pawnLoan: pawnLoanKeypair.publicKey,
        newLender: secondLenderKeypair.publicKey,
        lender: lenderKeypair.publicKey,
      })
      .signers([secondLenderKeypair])
      .rpc();
  });
});
