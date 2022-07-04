import { Program } from "@project-serum/anchor";
import { findProgramAddressSync } from "@project-serum/anchor/dist/cjs/utils/pubkey";
import {
  AccountInfo as TokenAccountInfo,
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  u64,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { PawnShop } from "../target/types/pawn_shop";

export const deserializeTokenAccountInfo = (
  data: Buffer | undefined
): TokenAccountInfo | undefined => {
  if (data == undefined || data.length == 0) {
    return undefined;
  }

  const accountInfo = AccountLayout.decode(data);
  accountInfo.mint = new PublicKey(accountInfo.mint);
  accountInfo.owner = new PublicKey(accountInfo.owner);
  accountInfo.amount = u64.fromBuffer(accountInfo.amount);

  if (accountInfo.delegateOption === 0) {
    accountInfo.delegate = null;
    accountInfo.delegatedAmount = new u64(0);
  } else {
    accountInfo.delegate = new PublicKey(accountInfo.delegate);
    accountInfo.delegatedAmount = u64.fromBuffer(accountInfo.delegatedAmount);
  }

  accountInfo.isInitialized = accountInfo.state !== 0;
  accountInfo.isFrozen = accountInfo.state === 2;

  if (accountInfo.isNativeOption === 1) {
    accountInfo.rentExemptReserve = u64.fromBuffer(accountInfo.isNative);
    accountInfo.isNative = true;
  } else {
    accountInfo.rentExemptReserve = null;
    accountInfo.isNative = false;
  }

  if (accountInfo.closeAuthorityOption === 0) {
    accountInfo.closeAuthority = null;
  } else {
    accountInfo.closeAuthority = new PublicKey(accountInfo.closeAuthority);
  }

  return accountInfo;
};

export const getBorrowerAndLenderSolBalance = async (
  program: Program<PawnShop>,
  borrower: PublicKey,
  lender: PublicKey
): Promise<number[]> => {
  const borrowerBalance = await program.provider.connection.getBalance(
    borrower
  );
  const lenderBalance = await program.provider.connection.getBalance(lender);
  return [borrowerBalance, lenderBalance];
};

export const getBorrowerAndLenderTokenBalance = async (
  program: Program<PawnShop>,
  borrower: PublicKey,
  lender: PublicKey
): Promise<(number | null)[]> => {
  const borrowerBalance = (
    await program.provider.connection.getTokenAccountBalance(borrower)
  ).value.uiAmount;
  const lenderBalance = (
    await program.provider.connection.getTokenAccountBalance(lender)
  ).value.uiAmount;
  return [borrowerBalance, lenderBalance];
};

export const delay = async (timeInMS: number) => {
  return new Promise((_) => setTimeout(_, timeInMS));
};
