# Pawnhub Contract

![License: Apache 2-0](https://img.shields.io/badge/license-Apache--2.0-blueviolet")
[![CI](https://github.com/TeamRaccoons/pawnhub-program/actions/workflows/main.yaml/badge.svg?branch=main)](https://github.com/TeamRaccoons/pawnhub-program/actions/workflows/main.yaml)

Pawnhub is a P2P pawning platform.

- Borrowers: Get a loan by pawning an NFT.
- Lenders: Fund a loan and earn interest or the underlying NFT.

## Definitions:

- Pawn: An item deposited as security for a loan (Noun). Or, the act of depositing the item (Verb).

## Program setup

- Download the spl token metadata program from mainnet

`solana program dump metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s spl_token_metadata.so -um`

## Deploy and verify

`anchor build --verifiable -- --features mainnet`

...
