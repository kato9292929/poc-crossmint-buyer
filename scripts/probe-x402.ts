/**
 * 任意の x402 エンドポイントに未払いでリクエストし、402 の accepts と、Crossmint の EVM ウォレットで払えるかの判定を記録する。
 *
 *   npm run probe:x402 -- <URL> [<URL> ...] [--save <ファイル>]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadAssets, probe402, selectRequirements } from '../src/x402/requirements.ts';

const args = process.argv.slice(2);
const saveIdx = args.indexOf('--save');
const save = saveIdx >= 0 ? args[saveIdx + 1] : undefined;
const urls = args.filter((a, i) => !a.startsWith('--') && i !== saveIdx + 1);
const assets = loadAssets();
const results = [];
for (const url of urls) {
  const { status, paymentRequired } = await probe402(url);
  results.push({
    url,
    status,
    x402Version: paymentRequired?.x402Version ?? null,
    accepts: paymentRequired?.accepts ?? null,
    crossmintEvmWallet: paymentRequired
      ? Object.fromEntries(['eip155:8453', 'eip155:84532'].map((n) => {
          const s = selectRequirements(paymentRequired, n, assets);
          return [n, s.ok ? `payable ($${Number(s.amountMicro) / 1e6})` : s.reason];
        }))
      : null,
  });
}
const record = { retrievedAt: new Date().toISOString(), results };
console.log(JSON.stringify(record, null, 2));
if (save) {
  mkdirSync(dirname(save), { recursive: true });
  writeFileSync(save, JSON.stringify(record, null, 2) + '\n');
  console.log(`保存: ${save}`);
}
