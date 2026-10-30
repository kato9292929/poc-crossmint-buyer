# 止まった箇所

指示書どおり、Crossmint 側でエラー・アクセス不可・未対応になった箇所は、回避策を探さずに記録する。キーは伏せる。

## A-1：Crossmint のウォレットでは JIN（Solana の x402）に署名できない

| 項目 | 内容 |
|---|---|
| 止まる場所 | `scripts/buy-jin.ts` → `src/x402/requirements.ts` の `selectRequirements`。ログの `error` が `not_payable_by_crossmint: …` |
| いつ確認したか | 2026-10-23（JST） |
| 本番で起きるか | 起きる。JIN が受け付けるのは Solana mainnet の USDC だけで（[phase0.md](phase0.md) の1）、Crossmint の x402 の経路は EVM（Base）だけ |
| 署名・送金 | していない（402 を読んだ時点で止める。資金は動かない） |

根拠（Crossmint 側の仕様）:

1. ドキュメント `https://docs.crossmint.com/wallets/guides/sign-message`（Solana のタブ）: 「Signing messages is not yet supported for Solana wallets. To send a transaction instead, see the Custom Solana Transactions guide.」
2. ドキュメント `https://docs.crossmint.com/agents/payment-flows/x402`: 前提が「A funded Crossmint EVM wallet on Base with USDC」。手順は `EVMWallet` と `ExactEvmScheme`（`eip155:*`）だけ。
3. SDK `@crossmint/wallets-sdk` 1.20.4 の `dist/wallets/solana.d.ts`: `SolanaWallet` のメソッドは `sendTransaction` だけ（`signTransaction`・`signMessage` が無い）。
4. x402 の Solana（exact）の支払いは、支払い元が部分署名したトランザクションを売り手のファシリテーター（feePayer `CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww`）に渡す方式（`@x402/svm` 2.28.0）。Crossmint の `sendTransaction` は Crossmint が送信まで行うので、この形にならない。

再現手順（キー不要）:

```bash
NODE_ENV=development npm run buy:jin -- --dry-run
# series: failure (not_payable_by_crossmint: 売り手が受け付けるのは exact/solana:5eykt…/EPjF…/10000→4s8X… だけ。…)
# movers: failure (not_payable_by_crossmint: …/20000→4s8X… だけ。…)

npm run x402:local -- --mode jin-solana --port 4403 &   # JIN と同じ 402 をローカルで返す
LOCAL_X402_URL=http://localhost:4403 npm run buy:jin -- --target local --dry-run
```

staging のキーを受け取ったら `npm run probe:solana` を1回実行し、Crossmint の Solana のウォレット（devnet）で次を確かめて、結果をこの節に追記する（資金は動かさない）。

- SDK の `SolanaWallet` が実際に持つメソッド
- REST の署名 API（`POST /api/2025-06-09/wallets/{locator}/signatures`）に Solana のウォレットでリクエストしたときの応答（そのまま記録する）
- ウォレットのアドレスを所有しているプログラム（スマートウォレットかどうか）

Crossmint（Alex Rawitz）から、この確認の API の応答をそのままメールのスレッドに送るよう頼まれている（担当は Alejandro）。`npm run probe:solana` は、貼り付け用の文面を `out/probe-solana-<日時>.md` にも書き出す。

### probe:solana の結果（1回目、2026-10-24 16:29 JST、本番のキー）

本人の指示で、staging ではなく本番のキー（`sk_production_…`）で実行した（`ALLOW_PRODUCTION=true npm run probe:solana -- --allow-production`）。資金は動かしていない。

| 項目 | 結果 |
|---|---|
| ウォレット | `2AjCRJWDH1ecvURP6ie7iMSTTtRYxcXmGLYmvdQ8MJjv`（Solana mainnet、サーバー署名者、alias `poc-crossmint-buyer-sol`）。作成は通った。mainnet 上にはまだアカウントが無い（`getAccountInfo` が `null`。初回の取引で作られるとみられる） |
| SDK の `SolanaWallet` | `signTransaction`・`signMessage` は無い（`sendTransaction`・`send`・`createTransaction`・`approve` などはある）。上の根拠3を実物で確認 |
| REST の署名 API | **キーのスコープ不足で 403。Solana で署名できるかの答えはまだ出ていない** |

```
POST https://www.crossmint.com/api/2025-06-09/wallets/solana%3Aalias%3Apoc-crossmint-buyer-sol/signatures
X-API-KEY: ***
{"type":"message","params":{"message":"x402 exact (svm) probe: can this wallet sign?"}}

HTTP 403
{"error":true,"message":"The API key provided doesn't have the required scopes to perform this action: wallets:signatures.create. It has the scopes: wallets.read,wallets.create,wallets:transactions.create,wallets:transactions.read."}
```

次: キーに `wallets:signatures.create` を足してもらい、同じコマンドをもう1回実行する（alias で同じウォレットを使うので、新しいウォレットは作られない）。

### probe:solana の結果（2回目、2026-10-24 19:33 JST、本番のキー、`wallets:signatures.create` 追加後）

**Crossmint の API が、Solana のウォレットでの署名を明示的に断った。** A-1 の根拠1（ドキュメント）・3（SDK）と一致する。ウォレットの種類は `solana-smart-wallet`（スマートウォレット）。資金は動かしていない。

```
POST https://www.crossmint.com/api/2025-06-09/wallets/solana%3Aalias%3Apoc-crossmint-buyer-sol/signatures
X-API-KEY: ***
{"type":"message","params":{"message":"x402 exact (svm) probe: can this wallet sign?"}}

HTTP 400
{"error":true,"message":"Signature type 'message' not supported for wallet type 'solana-smart-wallet'"}
```

この結果は Crossmint のスレッド（Alex Rawitz、Alejandro）に送る。

**4月に止まった箇所との対応**: 4月の記録はこのリポジトリと実証1・実証2の中には無かった。4月も「JIN の Solana の 402 に Crossmint で署名できない」で止まったのであれば、この A-1 と同じ箇所。ログの `error` の先頭 `not_payable_by_crossmint` で特定できる。

解消するには、次のどちらかが要る（どちらもこのリポジトリの外の変更なので、実装はしていない）。

- JIN の 402 の `accepts` に Base mainnet の USDC（`eip155:8453`、`0x8335…2913`）を足す。足されれば、このリポジトリのコードはそのまま Base の側を選んで払う（ローカルのテストサーバーで同じ形を確認済み。`test/buy-local.test.ts`、`test/requirements.test.ts`）
- Crossmint が Solana のウォレットで x402（部分署名したトランザクション、またはスマートウォレット用の x402）に対応する

## B：エージェントカード（order intent）

order intent の API は `/api/unstable/` 配下（早期アクセス）。staging のキーを受け取ってから本人が web/enroll で通す。エラーで止まった場合は、`scripts/enroll-server.ts` と `src/card-purchase.ts` が、エンドポイント・リクエスト・レスポンス（キー・JWT は伏せる）を下の「自動記録」に追記する。カード番号の取得の応答本文は、成功しても失敗しても記録しない（失敗の応答にカード番号は入らないが、13桁以上の数字列は伏せる）。

### 結果：止まらずに購入まで通った（2026-10-30 21:15 JST）

staging の order intent（VIC のレールを passkey で承認）からカード番号を取得し、実証1のプランを1回買えた。Nevermined の残高は 0 → 100。ログ: [evidence/phase-b-2026-10-30.jsonl](evidence/phase-b-2026-10-30.jsonl)。

途中で1回止まった箇所（Crossmint 側ではなく Nevermined 側の仕様変更）:

- `orderFiatPlan`（`@nevermined-io/payments` 1.13.0、`POST /api/v1/fiat/stripe/payment`、`sessionType: "embedded"`）が、Stripe Checkout の URL ではなく **Stripe の PaymentIntent**（`object: "payment_intent"`、`client_secret` つき、`livemode: false`、`payment_method_types: ["card","link"]`）を返すようになっていた。`sessionType` を `hosted`・`checkout`・`redirect` に変えても同じ
- ログの1行目（21:07、`orderFiatPlan の応答に checkout の URL が無い`）がこれ
- 対応: Nevermined App と同じく、Stripe Elements（Stripe 自身のカード入力欄）で PaymentIntent を確定する形に変えた。公開鍵は `https://nevermined.app/api/config` の `sandboxStripePublishableApiKey`（PaymentIntent と同じ Stripe アカウント）

Crossmint からの回答（Alex Rawitz、2026-10-23 のメール）:

- staging のアカウントは、申請なしで order intent を作れる。日本からの利用でも変わらない。staging の API キーには全スコープが付き、encrypted card のレールも全 staging プロジェクトで有効
- ドキュメントの「contact us」は本番の話（自前のチェックアウトで encrypted card を使う場合と、利用者に公開する前のプロジェクトの有効化）
- order intent はクライアント側のキー＋サインインした利用者の JWT が要る。サーバー側のキーで呼ぶと「Provided API key must be client specific」が返る（このリポジトリは web/enroll でクライアント側のキーと JWT を使っているので、この形になっている）

まだ記録は無い。

## 自動記録

<!-- 以下は scripts/enroll-server.ts・src/card-purchase.ts が追記する -->
