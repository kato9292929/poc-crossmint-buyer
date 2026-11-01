/**
 * フェーズA（Base）：Crossmint のエージェントウォレットで、任意の x402 エンドポイントを1回買う。
 *
 *   npm run buy:x402 -- --url <URL> --expected-usd 0.005 [--allow-production]
 *
 * - 1回 $0.05・1日 $0.50 の上限、想定価格・許可資産（config/assets.json）・ウォレットのネットワークと違う 402 には署名しない
 * - 本番（sk_production_）は ALLOW_PRODUCTION=true と --allow-production の両方が要る。同じ URL は本番で成功が1回あれば買わない
 * - 本文は out/、購入結果は logs/YYYY-MM-DD.jsonl（JST。本番は NODE_ENV=development 必須）
 */
import { readdirSync } from 'node:fs';
import { crossmintEnv, required, spendCaps } from '../src/config.ts';
import { SpendGuard } from '../src/caps.ts';
import { getOrCreateAgentWallet, x402SignerFrom } from '../src/crossmint/wallet.ts';
import { fileLoggingEnabled, logDir, readDay } from '../src/log.ts';
import { buyOnce, signedSpendForDay } from '../src/x402/buyer.ts';
import { loadAssets } from '../src/x402/requirements.ts';

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = arg('url');
const expectedUsd = arg('expected-usd');
if (!url || !expectedUsd) throw new Error('--url と --expected-usd が要る');

const env = crossmintEnv(required('CROSSMINT_SERVER_API_KEY'));
if (env === 'production') {
  if (!args.includes('--allow-production')) throw new Error('本番では --allow-production を付ける（ALLOW_PRODUCTION=true と両方）');
  if (!fileLoggingEnabled()) throw new Error('本番は NODE_ENV=development（ログをファイルに出す）で実行する');
  const bought = readdirSync(logDir())
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .some((f) => readDay(f.slice(0, 10)).some((e) => e.phase === 'A' && e.env === 'production' && e.item === url && e.result === 'success'));
  if (bought) throw new Error(`${url} は本番で購入済み（支払いは1回だけ）`);
}

const { perCall, perDay } = spendCaps();
const aw = await getOrCreateAgentWallet();
console.log(`相手: ${url}  環境: ${env}  ウォレット: ${aw.address}（${aw.network}）  上限: 1回 ${perCall}µ$ / 1日 ${perDay}µ$`);
const r = await buyOnce({
  url,
  expectedUsd,
  signer: x402SignerFrom(aw),
  walletNetwork: aw.network,
  payer: aw.address,
  guard: new SpendGuard(perCall, perDay, signedSpendForDay),
  assets: loadAssets(),
  env,
  target: new URL(url).host,
  seller: new URL(url).host,
});
console.log(`${r.entry.result}${r.entry.tx ? ` tx=${r.entry.tx}` : ''}${r.entry.error ? ` (${r.entry.error})` : ''}${r.bodyFile ? ` 本文=${r.bodyFile}` : ''}`);
process.exit(r.entry.result === 'success' ? 0 : 2);
