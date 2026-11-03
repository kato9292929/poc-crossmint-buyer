# poc-crossmint-buyer

A proof of concept that uses **Crossmint as the buyer**. An agent wallet and an agent card buy from our own paid endpoints, to see whether each purchase path goes through end to end:

| Path | Buyer | Seller | What is bought |
|---|---|---|---|
| A. Wallet | Crossmint server agent wallet (`@crossmint/wallets-sdk`) | x402 endpoints | Per-call API access, paid in USDC |
| B. Card | Crossmint Agent Cards (order intent → one-time card number) | A Nevermined prepaid plan, paid by card through Stripe | A $1 / 100-credit plan |

The detailed working notes in `docs/` are in Japanese. This README summarizes the results and the feedback for Crossmint.

## Results at a glance

| Path | Environment | Result | Evidence |
|---|---|---|---|
| A. Wallet → x402 on **Solana** (USDC) | production | **Blocked.** A Crossmint Solana wallet cannot sign an x402 payment | [`docs/blockers.md`](docs/blockers.md) (A-1) |
| A. Wallet → x402 on **Base** (USDC) | production | **Paid**, on the 2nd attempt. $0.005, tx [`0x34cc5159…3b03`](https://basescan.org/tx/0x34cc51597649c94250caca5d5fdaaafb8c03fb8b909144f80d5aef9e28fc3b03) | [`docs/evidence/phase-a-base-2026-11-02.jsonl`](docs/evidence/phase-a-base-2026-11-02.jsonl) |
| B. Agent card → Nevermined plan | Crossmint staging × Nevermined sandbox (Stripe test mode) | **Purchased.** VIC rail, Stripe PaymentIntent `succeeded`, credits 0 → 100 | [`docs/evidence/phase-b-2026-10-30.jsonl`](docs/evidence/phase-b-2026-10-30.jsonl) |
| B. Agent card in production (Mastercard Agent Pay, real card) | production | **On hold.** The seller plan is not live yet, and production needs our own auth provider | [`docs/blockers.md`](docs/blockers.md) (C) |

## Path A: agent wallet → x402

### Solana: blocked

Our endpoint (Japan Inflation Nowcall, `jin.x402jp.com`) only accepts `exact` / `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` / USDC. An x402 `exact` payment on Solana requires the buyer to return a **partially signed transaction**: a `TransferChecked` with the buyer as authority, and the seller's facilitator as fee payer. A Crossmint Solana wallet cannot produce that.

- The docs (`/wallets/guides/sign-message`, Solana tab) say: "Signing messages is not yet supported for Solana wallets."
- In `@crossmint/wallets-sdk` 1.20.4, `SolanaWallet` has `sendTransaction`, but no `signTransaction` or `signMessage`.
- The REST API rejects it explicitly. This was with a production server key, on 2026-10-24:

```
POST https://www.crossmint.com/api/2025-06-09/wallets/solana%3Aalias%3Apoc-crossmint-buyer-sol/signatures
{"type":"message","params":{"message":"x402 exact (svm) probe: can this wallet sign?"}}

HTTP 400
{"error":true,"message":"Signature type 'message' not supported for wallet type 'solana-smart-wallet'"}
```

`buy:jin` therefore stops before signing, and logs `not_payable_by_crossmint`. You can reproduce this without any keys: `npm run buy:jin -- --dry-run`.

### Base: paid

- **Endpoint:** we picked `https://tick.hugen.tokyo/tick/symbols` ($0.005). Its 402 offers both Base USDC and Solana USDC, and the buyer selects the Base option.
- **Wallet:** `0xcFe61527Bd815688B3c24fD0Bf57b3A7d62B307d`.
- **Signer:** `EVMWallet.from(wallet)` → `ExactEvmScheme`, as in Crossmint's x402 guide, with `@x402/fetch` `wrapFetchWithPayment`.

| Attempt (2026-11-02, UTC) | Result |
|---|---|
| 11:55:38 | **Failed, no funds moved.** The wallet was not deployed yet, so the signature was ERC-6492. The facilitator deployed the wallet ([`0xcbede685…19dd7`](https://basescan.org/tx/0xcbede6859f25de2c8e93915bf146760d7bbe83f1be37a569a984a06fef519dd7), `deployWithFactory`, success). The transfer then failed with `Facilitator settle failed (400): failed to send transaction: invalid_request: unable to estimate gas` (`invalid_payload`). |
| 11:56:35 | **Success.** The wallet was deployed by then, so the signature was a plain ERC-1271 one. The `transferWithAuthorization` succeeded: tx `0x34cc5159…3b03`, USDC balance 1 → 0.995, HTTP 200. |

**Lesson:** the first x402 payment from a Crossmint EVM wallet that is not yet deployed can fail. Whether it does depends on how the facilitator handles ERC-6492 deploy-then-transfer. Deploying the wallet beforehand (any first transaction) should avoid it.

## Path B: agent card → Nevermined prepaid plan (staging)

The flow runs entirely in a cloud session with Playwright, with no human in the loop (`npm run card:flow`):

1. **Sign-in.** Crossmint **Custom tokens** (our own RS256 JWT). The JWKS is served from this public repo: [`web/public/jwks.json`](web/public/jwks.json). This mode is staging only.
2. **Save a card.** `CrossmintPaymentMethodManagement` with test card `4000 0566 5566 5556`.
3. **Register** the card with `PUT /api/2026-09-16/payment-methods/{id}/order-intent-registration`.
4. **Create an order intent** with `POST /api/unstable/order-intents`: $1.00, merchant Nevermined, expires in 2 h.
5. **Verify the VIC rail.** `OrderIntentVerification` runs the Basis Theory mock: a 6-digit OTP, then the Visa passkey popup, completed with a WebAuthn virtual authenticator.
6. **Mint a card number** with `POST /api/unstable/order-intents/{id}/credentials` (`agentic-token` / `vic`).
7. **Pay** the Stripe PaymentIntent that Nevermined returns, through Stripe Elements, then poll the Nevermined credit balance.

Result (2026-10-30): order intent `3ce1717b-…`, Stripe `pi_3UWEiMPh60bb0BjN12CaN4hJ` `succeeded`, credits 0 → 100.

Notes from this path:

- **The VIC mock number depends on the saved card.** Saving `4000 0566 5566 5556` makes the VIC mock mint `4000 0010 0000 0000`. That number is also a Stripe test card, so Stripe test mode accepts it. Saving `4242 4242 4242 4242` mints `4000 0010 0000 4242`, which is not a Stripe test card. Thanks to Alex for confirming this.
- **Staging returns more rails than we expected.** On staging, a new order intent comes back with `spt` and `encrypted-card` already `active`, while `vic` is still `pending_verification`. We chose to verify the network rail first, as the docs recommend, rather than taking the first active rail.
- **Order intents need a client key and a user JWT.** A server key returns "Provided API key must be client specific".

### Production: on hold

- The seller's Nevermined plan has not been migrated to live yet. Stripe test mode does not accept real card numbers.
- Crossmint Auth is staging only. Production needs a third-party auth provider (we plan to use Firebase).
- We are in Japan and pay through our own checkout. Per the Agent Cards quickstart, a non-US Visa would use the encrypted-card rail, which needs encrypted card access in production. Mastercard Agent Pay lists no country restriction, so our plan is to use a Mastercard.

## Feedback for Crossmint

1. **Solana x402.** We would like either a sign-only / partial-sign API for Solana wallets, or support for the smart-wallet x402 path (Squads). The smart-wallet path would also need the seller's facilitator to accept smart-wallet payments. With either, Crossmint wallets could pay the many x402 endpoints that only accept Solana USDC.
2. **The first payment from an undeployed EVM wallet.** As described above, it failed at gas estimation after the facilitator deployed the wallet. A note in the x402 guide, or an SDK helper that deploys the wallet first, would help.
3. **Server key scopes for x402.** Paying x402 needed `wallets:signatures.create` **and** `wallets:signatures.read`. Without the read scope, the SDK fails with `wallet:no-signature` after the signature has been created. Reading balances needs `wallets:balance.read`. The x402 guide does not list these scopes.
4. **`EVMWallet.signTypedData` requires `domain.verifyingContract`.** It throws `Invalid typed data domain` without it, even though EIP-712 makes that field optional. This did not matter for x402, because USDC's domain always has it.

## Safety rails in the code

- **Spending limits.** At most $0.05 per call and $0.50 per day, both enforced **before signing**. Environment variables can only lower them. A 402 is never signed if its amount differs from the expected price, if the asset is not on the allow-list (`config/assets.json`), or if it is on another network.
- **Production guard.** Running in production needs both `ALLOW_PRODUCTION=true` and `--allow-production`. Each production URL is bought at most once.
- **Card numbers.** Minted card numbers live only inside a `CardCredential` object. That object never serializes them and wipes them after use. They are never logged, printed, screenshotted or written to a file.
- **Logs.** One JSON line per purchase in `logs/YYYY-MM-DD.jsonl`, with the day boundary in JST. Files are written only when `NODE_ENV=development`. Copies of the relevant lines are in `docs/evidence/`.

## Running it

Requires Node 22+. Copy `.env.example` to `.env` and fill it in; never commit `.env`.

```bash
npm ci
npm test                      # unit tests, including a local 402 → sign → retry loop
npm run probe:x402 -- <url>   # fetch a 402 without paying and record its accepts
npm run check:evm-signer      # sign a harmless EIP-712 message and verify it on-chain (no funds move)
npm run buy:x402 -- --url <url> --expected-usd 0.005 [--allow-production]
npm run x402:local            # local x402 server that mirrors our endpoint's 402 (Base Sepolia, verifies only)
npm run probe:solana          # the Solana signing probe above
npm run card:flow             # Path B on staging (needs CROSSMINT_CLIENT_API_KEY and NVM_API_KEY_BUYER)
```

## Layout

| Path | Contents |
|---|---|
| `src/x402/` | Reading the 402, choosing what to pay, the buyer with spending limits, and the local test server |
| `src/crossmint/` | The server agent wallet, the order-intent REST client and the Custom-token JWT |
| `src/stripe-elements.ts` | Pays the Nevermined PaymentIntent through Stripe Elements |
| `src/card-purchase.ts` | Path B: order intent → card number → payment → credits |
| `web/enroll/` | Sign-in, card saving and order-intent approval page (React) |
| `scripts/` | Command-line entry points (see `package.json`) |
| `docs/` | Working notes (Japanese): `phase0.md` research, `blockers.md` where things stopped, `handoff.md` notes for our reporting, `evidence/` raw logs |
