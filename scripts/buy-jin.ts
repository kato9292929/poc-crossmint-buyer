/**
 * フェーズA：Crossmint のエージェントウォレットで JIN の series（$0.01）と movers（$0.02）を各1回買う。
 * レスポンス本文は out/、購入結果は logs/YYYY-MM-DD.jsonl（JST、NODE_ENV=development のときだけ）に残す。
 *
 *   npm run buy:jin                      # 相手は jin.x402jp.com
 *   npm run buy:jin -- --target local    # ローカルの x402 テストサーバー（npm run x402:local）
 *   npm run buy:jin -- --only series
 *   npm run buy:jin -- --dry-run         # Crossmint に触らず、402 と払えるかの判定だけをログに残す
 *
 * 1回 $0.05・1日 $0.50 を超える 402、想定価格と違う 402、Crossmint で署名できないネットワークの 402 には署名しない。
 * 本番（sk_production_）は ALLOW_PRODUCTION=true が必要で、JIN の各エンドポイントは成功が1回あればそれ以上買わない。
 */
import { readdirSync } from 'node:fs';
import { JIN_BASE_URL, LOCAL_X402_URL, crossmintEnv, evmChainFor, optional, spendCaps } from '../src/config.ts';
import { SpendGuard } from '../src/caps.ts';
import { getOrCreateAgentWallet, x402SignerFrom } from '../src/crossmint/wallet.ts';
import { JIN_ENDPOINTS } from '../src/jin.ts';
import { fileLoggingEnabled, jstDay, logDir, readDay } from '../src/log.ts';
import { buyOnce, signedSpendForDay } from '../src/x402/buyer.ts';
import { loadAssets } from '../src/x402/requirements.ts';

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = arg('target') ?? 'jin';
if (target !== 'jin' && target !== 'local') throw new Error('--target は jin か local');
const baseUrl = target === 'jin' ? JIN_BASE_URL : LOCAL_X402_URL;
const only = arg('only');
const dryRun = args.includes('--dry-run');
const endpoints = JIN_ENDPOINTS.filter((e) => !only || e.id === only);
if (endpoints.length === 0) throw new Error(`--only ${only} は不明`);

const apiKey = optional('CROSSMINT_SERVER_API_KEY');
const env = apiKey ? crossmintEnv(apiKey) : 'none';
const walletNetwork = apiKey ? evmChainFor(env as 'staging' | 'production').network : 'eip155:8453';

/** 本番の JIN は、各エンドポイント1回だけ（成功が記録済みなら止める）。 */
function alreadyBoughtInProduction(url: string): boolean {
  let files: string[] = [];
  try {
    files = readdirSync(logDir()).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    return false;
  }
  return files.some((f) => readDay(f.slice(0, 10)).some((e) => e.phase === 'A' && e.env === 'production' && e.target === 'jin' && e.item === url && e.result === 'success'));
}

// 本番の「各1回だけ」と1日の上限の復元はログファイルで判定するので、本番はファイル出力が有効なときだけ動かす
if (env === 'production' && !fileLoggingEnabled()) throw new Error('本番は NODE_ENV=development（ログをファイルに出す）で実行する');

const { perCall, perDay } = spendCaps();
const guard = new SpendGuard(perCall, perDay, signedSpendForDay);
const aw = apiKey && !dryRun ? await getOrCreateAgentWallet() : null;
console.log(`相手: ${baseUrl}  環境: ${env}  ウォレット: ${aw?.address ?? '(未使用)'}  上限: 1回 ${perCall}µ$ / 1日 ${perDay}µ$（JST ${jstDay()}）`);

let failed = 0;
for (const ep of endpoints) {
  const url = `${baseUrl}${ep.path}`;
  if (env === 'production' && target === 'jin' && alreadyBoughtInProduction(url)) {
    console.log(`${ep.id}: 本番で購入済み。スキップ`);
    continue;
  }
  const r = await buyOnce({
    url,
    expectedUsd: ep.priceUsd,
    signer: aw ? x402SignerFrom(aw) : null,
    walletNetwork: aw?.network ?? walletNetwork,
    payer: aw?.address ?? null,
    guard,
    assets: loadAssets(),
    env,
    target,
  });
  console.log(`${ep.id}: ${r.entry.result}${r.entry.tx ? ` tx=${r.entry.tx}` : ''}${r.entry.error ? ` (${r.entry.error})` : ''}${r.bodyFile ? ` 本文=${r.bodyFile}` : ''}`);
  if (r.entry.result !== 'success') failed++;
}
process.exit(failed ? 2 : 0);
