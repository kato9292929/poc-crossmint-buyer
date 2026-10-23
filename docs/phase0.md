# フェーズ0：事前調査の記録

調査日: 2026-10-23（JST）。本人の操作なしで確認できる範囲。

参照したドキュメントは、指示書のリンクではなく `https://docs.crossmint.com/llms.txt`（2026-10-23 取得）から辿った最新版。指示書の想定と違った点は「指示書との差分」にまとめた。

## 確認した版

| 対象 | 版 |
|---|---|
| `@crossmint/wallets-sdk` | 1.20.4（npm latest） |
| `@crossmint/client-sdk-react-ui` | 4.11.0（web/enroll） |
| `@x402/core` `@x402/evm` `@x402/svm` `@x402/fetch` | 2.28.0（実証1と同じ） |
| `@nevermined-io/payments` | 1.13.0（実証1と同じ） |

## 1. JIN の 402（未払いリクエスト）

`npm run probe:jin -- --save` の結果（そのまま: [evidence/jin-402-2026-10-23T05-36-08-022Z.json](evidence/jin-402-2026-10-23T05-36-08-022Z.json)）。

| エンドポイント | x402 | scheme | network | asset | amount | payTo | extra |
|---|---|---|---|---|---|---|---|
| `GET https://jin.x402jp.com/api/jin/series` | v2（`PAYMENT-REQUIRED` ヘッダ） | exact | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`（Solana mainnet） | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`（USDC） | 10000（$0.01） | `4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf` | `feePayer: CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww`、`maxTimeoutSeconds: 300` |
| `GET https://jin.x402jp.com/api/jin/movers` | 同上 | exact | 同上 | 同上 | 20000（$0.02） | 同上 | 同上 |

- `accepts` は Solana mainnet の USDC の1件だけ。**Base（EVM）の選択肢は無い**。`/.well-known/x402.json` も `network: solana:5eykt…`、トップページにも「決済は Solana USDC」とある。
- `extra.features.smartWalletSupported` は無い（x402 2.28.0 のファシリテーターが、スマートウォレットからの支払いを受け付ける設定のときに付ける印）。

## 2. Crossmint のウォレットでその network・asset を払えるか

**払えない。** 理由は3つで、どれも Crossmint 側の仕様。

1. **Crossmint の x402 の手順は EVM（Base）専用。** x402 のページ（`/agents/payment-flows/x402`）の前提は「A funded Crossmint EVM wallet on Base with USDC」で、コードも `EVMWallet.from(wallet)` → `signTypedData` → `client.register("eip155:*", new ExactEvmScheme(...))`。Solana の手順は無い。
2. **Crossmint の Solana ウォレットは署名を返せない。** 公式の Sign Messages（`/wallets/guides/sign-message`）に「Signing messages is not yet supported for Solana wallets」とある。SDK 1.20.4 の `SolanaWallet`（`dist/wallets/solana.d.ts`）が持つのは `sendTransaction` だけで、`signTransaction`・`signMessage` が無い（EVM の `EVMWallet` には `signMessage`・`signTypedData` がある）。
3. **x402 の Solana（exact）の支払いには「部分署名したトランザクション」が要る。** `@x402/svm` 2.28.0 のクライアント（`dist/cjs/exact/client/index.js` の `createPaymentPayload`）は、支払い元が `TransferChecked` の authority として署名し、手数料の支払い元（feePayer）は売り手側のファシリテーターにしたトランザクションを作って、`partiallySignTransactionMessageWithSigners` で部分署名する。Crossmint の `sendTransaction` は Crossmint が自分で送信まで行うので、ファシリテーターに渡す部分署名のトランザクションを作れない。さらに Crossmint のウォレットはスマートウォレット（USDC はウォレットのプログラムが持つ）なので、仮に部分署名できても、ファシリテーターがスマートウォレットの検証を有効にしている必要がある（JIN の 402 にはその印が無い。上の1）。

→ 指示書の想定（「JIN が受け付けるのが Base 本番の USDC なら、staging では実購入まで通らない」）より手前で止まる。**JIN は Base を受け付けないので、本番でも Crossmint のウォレットでは JIN を買えない。** 詳細と再現手順は [blockers.md](blockers.md) の A-1。

staging での確認は、指示書の方針どおりローカルの x402 テストサーバーで行う（`npm run x402:local`）。JIN の 402 をパス・説明・金額・タイムアウトまで再現し、network・asset だけを Base Sepolia の USDC に置き換えたもの（Crossmint の staging ウォレットが払える形）と、JIN の Solana の 402 をそのまま返すもの（`--mode jin-solana`、払えないことの再現）の2つを用意した。

## 3. 実証1の Nevermined プランの購入経路

読んだもの: `kato9292929/poc-card-credits` の README、`docs/nevermined.md`、`docs/go-live.md`、`scripts/order-plan.ts`、`src/gateway/app.ts`、`config/sandbox.json`、`config/plans.json`。

| 項目 | 内容 |
|---|---|
| プラン | `prepaid-100`（$1・100 クレジット・30日有効）。`NVM_PLAN_ID=61852813…774087` |
| 環境 | **Nevermined Sandbox だけ**（`NVM_ENVIRONMENT=sandbox`。go-live の条件を満たすまで live は起動しない）。カード決済は Stripe の**テストモード** |
| 買い方 | 買い手のキーで `payments.plans.orderFiatPlan(planId)` → **Stripe Checkout（ホスト型）の URL** が返る → そのページでカードを入れて払う → Stripe の webhook でクレジットが付与される |
| API でカード番号を渡して買う経路 | **無い**（SDK 1.13.0 にも公式ドキュメントにも無い。Braintree のプランは SDK では買えない） |

**判断: カード番号で買える経路はある（Stripe Checkout のページ）ので、フェーズBは実装する。** ただし API ではなくブラウザのページなので、取得したカード番号は Playwright で Stripe Checkout の入力欄に直接入れる（`src/stripe-checkout.ts`）。

この経路から決まること:

- Nevermined が Sandbox なので、Stripe はテストモード。**テストモードの Stripe は Stripe のテストカードしか通さない**。本番の Crossmint で取った本物のカード番号は使えない。したがってフェーズBは **Crossmint staging ＋ Nevermined Sandbox** の組み合わせで行う（実際の請求は発生しない）。
- Crossmint staging のカードネットワークのレールは決まった値の模擬カード番号を返す（`/agents/payment-methods/cards/test-agent-cards`）。
  - 保存したカードが `4242 4242 4242 4242` のとき → `4000 0010 0000 4242`。**Stripe のテストカードの一覧に無い**ので、Stripe のテストモードで拒否される見込み。
  - それ以外の Visa（例 `4000 0566 5566 5556`。Stripe のテストカードでもある）→ `4000 0010 0000 0000`。**Stripe のテストカード（ブルガリア発行の Visa）と同じ番号**なので通る見込み。
  - よって web/enroll では staging のとき `4000 0566 5566 5556` を保存するよう案内している。
- Nevermined Sandbox の買い手アカウントの API キー（`NVM_API_KEY_BUYER`）が要る（本人への依頼に含めた）。

## 4. 実証2の日次集計と、Crossmint 経由の購入の見え方

[handoff.md](handoff.md) に書いた。

## 指示書との差分（最新ドキュメントに従ったもの）

| 指示書 | 最新のドキュメント／実際 | 対応 |
|---|---|---|
| x402 のクライアントは `@x402/core` の `wrapFetchWithPayment` | 2.28.0 では `wrapFetchWithPayment` は `@x402/fetch` にある（`@x402/core/client` には `x402Client`・`x402HTTPClient`） | `@x402/fetch` から使う |
| カード番号の取得: `/agents/payment-methods/cards/retrieve-virtual-card` | このページは無くなり、`/agents/payment-methods/cards/retrieve-agent-card`（Get a Card Number）に変わった | 新しいページに従う |
| エージェントカード作成（order intent）のページ名 | `/agents/payment-methods/cards/create-agent-card` は「Approve an Order Intent」。カード保存（Save a Card）と登録（Register a Card）が別ページに分かれた | 保存 → 登録 → order intent → 承認 → 番号取得、の順に実装 |
| カード番号は「加盟店ごとのカード番号」 | レールが3種類: カードネットワーク（Visa Intelligent Commerce・Mastercard Agent Pay。加盟店と金額に縛られた1回限りの番号）、Stripe の SPT、encrypted card（保存したカードそのものを暗号化して渡す。本番は要申請）。VIC は**米国発行の個人向け Visa だけ**、Mastercard Agent Pay は Mastercard | active なカードネットワークのレールを優先し、無ければ encrypted card（ドキュメントの方針どおり） |
| 利用者の認証 | order intent の API は、クライアントキー＋利用者の JWT（自前の認証基盤か、staging なら Crossmint Auth）。サーバーキーだけでは呼べない | web/enroll は Crossmint Auth（メールのワンタイムコード）でサインインし、JWT をリクエストごとにローカルのサーバーに渡す |
| stagingFund | テストトークンは USDXM（`wallet.stagingFund(n)`）。x402 の EVM の支払いは EIP-3009 の署名なので、ローカルのテストサーバー相手なら残高が無くても署名と再送までは確かめられる（決済はしない） | `npm run wallet:setup -- --fund 5` で入れられるようにはしてある |
