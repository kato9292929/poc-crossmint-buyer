/**
 * JIN の 402 を再現したローカルの x402 テストサーバーを起動する（staging の動作確認用。決済はしない）。
 *
 *   npm run x402:local                       # Base Sepolia の USDC に置き換えた 402（Crossmint staging で払える形）
 *   npm run x402:local -- --mode jin-solana  # JIN と同じ Solana mainnet USDC の 402（Crossmint で払えないことの再現）
 *   npm run x402:local -- --port 4402 --verify offline
 */
import { startLocalX402Server } from '../src/x402/local-server.ts';

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const { url } = await startLocalX402Server({
  port: Number(arg('port') ?? 4402),
  mode: (arg('mode') as 'evm' | 'jin-solana') ?? 'evm',
  verify: (arg('verify') as 'rpc' | 'offline') ?? 'rpc',
  payTo: arg('pay-to') as `0x${string}` | undefined,
});
console.log(`ローカル x402 テストサーバー: ${url}  (GET /api/jin/series, /api/jin/movers)`);
