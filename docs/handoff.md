# 実証2（poc-dual-checkout）への引き継ぎ

指示書どおり、実証2・実証1・JIN には変更を入れていない。実証2の集計に載せるために必要な変更点だけを書く。

読んだもの（2026-10-23 時点の `main`）: README、`docs/sources.md`、`config/site.json`、`config/own_wallets.json`（version 6）、`config/external_buyers.json`（version 2）、`scripts/collect-daily.mjs`、`lib/solana.js`、`lib/stripe.js`、`lib/nevermined.js`、`lib/gateway.js`。

## 実証2の日次集計が見ているもの

| 入口 | データ | 購入者の識別 |
|---|---|---|
| USDC 直接 | Solana mainnet の、JIN の payTo（`4s8X…3VPf`）への USDC の入金（`lib/solana.js` の `fetchPayments`） | USDC が減ったトークン口座の owner（`payer`）。`own_wallets.json` の `solana` に一致すれば own、`external_buyers.json` に一致すれば external、どちらでもなければ unclassified |
| カード | Stripe の取引（`card.purchase_source: "stripe"`、既定）／Nevermined の `plan.purchased` イベント（`nvm_events`）／実証1ゲートウェイのログ（`GET /logs/:date`） | Stripe の取引 ID の匿名値（`stripe_txn_hashes`）、Nevermined の userId の匿名値（`nvm_user_hashes`）、実証1のトークン ID（`card_token_ids`） |

チェーンは Solana だけを読んでいて、Base（EVM）は読んでいない。

## このリポジトリの購入が、実証2でどう見えるか

### フェーズA（Crossmint のウォレット → JIN）

- **現状は実証2に何も出ない。** Crossmint のウォレットでは JIN（Solana）に署名できず、支払いは1件も起きていない（[blockers.md](blockers.md) の A-1）。
- 今後 JIN が Base の USDC も受け付けるようになり、このリポジトリで買えた場合: 支払いは **Base mainnet** に出る。実証2は Base を読まないので、USDC 入口の件数には入らない（Solana の集計にも出ない）。
- 支払い元は Crossmint のスマートウォレットのアドレス（`npm run wallet:setup` が表示する `0x…`。本人の入金後に確定する）。このリポジトリのログ（`logs/YYYY-MM-DD.jsonl`）の `payer` と `tx` で1件ずつ突き合わせられる。

### フェーズB（Crossmint のカード → Nevermined のプラン）

- Nevermined Sandbox（Stripe のテストモード）での購入なので、実証2がテストモードの取引を読んでいない限り、カード入口の件数には出ない。
- Stripe 上は普通のカード決済に見える。Crossmint 経由であることを示す印は取引に付かない（カード番号は Crossmint が発行した1回限りの番号だが、Stripe にはブランドと下4桁しか残らない）。
- 識別に使えるもの:
  - このリポジトリのログの `tx`（Stripe Checkout のセッション ID `cs_test_…`）。Stripe の API でセッション → PaymentIntent → 残高取引（`txn_…`）とたどれば、実証2の `txn_hash`（`txn_…` の匿名値）と突き合わせられる
  - 購入に使った Nevermined の買い手アカウント。このリポジトリ専用の買い手アカウントにすれば、その userId の `plan.purchased` はすべて Crossmint のカード経由になる
  - 実証1のゲートウェイを通して使った場合は、実証1のトークン ID（`card_token_ids`）

## 実証2に必要な変更（実装はしていない）

1. **`config/own_wallets.json`**（どの段階でも必要）: このリポジトリの買い手を「自社」として登録し、全集計から除外する。`version` を上げ、`CHANGELOG.md` に記録して `--resummarize` で数え直す。
   - `solana`: 追加なし（Solana では支払っていない）
   - フェーズAが Base で動いた場合: Crossmint のウォレットのアドレス（`label: "Crossmint エージェントウォレット（poc-crossmint-buyer）"`）。今の形式は `solana` の配列だけなので、`base`（または `evm`）の配列を足す
   - フェーズB: 専用の Nevermined の買い手アカウントの userId を `nvm_user_hashes`（実証2の匿名化と同じ値）に、Stripe の取引を使う場合は `stripe_txn_hashes` に入れる
2. **Base のチェーンの読み取り**（フェーズAが Base で動いた場合だけ）: `lib/solana.js` に相当する Base 用の読み取り（JIN の Base の payTo への USDC の `Transfer` を読み、`from` を payer にする）と、`config/site.json` の `usdc` に Base の payTo・asset を足す変更。JIN が Base を受け付けない間は不要。
3. **買い手の区分の追加**（任意）: own の別表に「Crossmint 経由」を出したい場合は、`own_wallets.json` の各項目の `role`（実証1のゲートウェイは `card_gateway`）に `crossmint_wallet` / `crossmint_card` を足し、`lib/aggregate.js` で role ごとに数える。このリポジトリのログは 1購入1行で、`buyer`（`crossmint-wallet` / `crossmint-card`）・`seller`・`payer`・`tx` を持っているので、照合用にそのまま使える。

## 実証2に渡す値（確定したら追記する）

| 値 | 状態 |
|---|---|
| Crossmint のウォレット（本番、Base） | 未作成（本人の API キー発行後に `npm run wallet:setup`） |
| Crossmint のウォレット（staging、Base Sepolia） | 未作成 |
| フェーズBの Nevermined の買い手アカウント | このリポジトリ専用の Sandbox の買い手を新しく作る（2026-10-25 決定）。userId は作成後に追記する。この userId の `plan.purchased` はすべて Crossmint のカード経由 |
| Crossmint の Solana のウォレット（本番） | `2AjCRJWDH1ecvURP6ie7iMSTTtRYxcXmGLYmvdQ8MJjv`（確認用に作っただけ。支払いには使っていない） |
| フェーズBの Stripe Checkout のセッション ID | 未購入 |
