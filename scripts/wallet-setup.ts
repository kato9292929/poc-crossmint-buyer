/**
 * サーバー側エージェントウォレットを作成（または alias で取得）し、アドレスと残高を表示する。
 * staging では --fund <USDXM> でテストトークンを入れる（stagingFund。本番では使えない）。
 *
 *   npm run wallet:setup
 *   npm run wallet:setup -- --fund 5
 */
import { getOrCreateAgentWallet } from '../src/crossmint/wallet.ts';

const args = process.argv.slice(2);
const fundIdx = args.indexOf('--fund');
const fund = fundIdx >= 0 ? Number(args[fundIdx + 1]) : 0;

const aw = await getOrCreateAgentWallet({ create: true });
console.log(`環境: ${aw.env}  チェーン: ${aw.chain}  ネットワーク: ${aw.network}`);
console.log(`ウォレット: ${aw.address}`);

if (fund > 0) {
  if (aw.env !== 'staging') throw new Error('stagingFund は staging だけ');
  if (!(fund > 0 && fund <= 10)) throw new Error('--fund は 0〜10 の範囲');
  const r = await aw.wallet.stagingFund(fund);
  console.log('stagingFund:', JSON.stringify(r));
}

const balances = await aw.wallet.balances(aw.env === 'staging' ? ['usdxm'] : []);
console.log('残高:', JSON.stringify(balances, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
