/**
 * フェーズ0-1：JIN の有料エンドポイントに未払いでリクエストし、402 の accepts を記録する。キーは要らない。
 *
 *   npm run probe:jin            # 標準出力に出す
 *   npm run probe:jin -- --save  # out/jin-402-<日時>.json にも保存
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { JIN_BASE_URL } from '../src/config.ts';
import { JIN_ENDPOINTS } from '../src/jin.ts';
import { loadAssets, probe402, selectRequirements } from '../src/x402/requirements.ts';

const assets = loadAssets();
const results = [];
for (const ep of JIN_ENDPOINTS) {
  const url = `${JIN_BASE_URL}${ep.path}`;
  const { status, paymentRequired } = await probe402(url);
  const verdict = paymentRequired
    ? Object.fromEntries(['eip155:8453', 'eip155:84532'].map((n) => {
        const s = selectRequirements(paymentRequired, n, assets);
        return [n, s.ok ? 'payable' : s.reason];
      }))
    : null;
  results.push({ url, status, expectedUsd: ep.priceUsd, accepts: paymentRequired?.accepts ?? null, crossmintEvmWallet: verdict });
}
const record = { retrievedAt: new Date().toISOString(), results };
console.log(JSON.stringify(record, null, 2));
if (process.argv.includes('--save')) {
  mkdirSync('out', { recursive: true });
  const file = `out/jin-402-${record.retrievedAt.replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`保存: ${file}`);
}
