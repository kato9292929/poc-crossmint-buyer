/**
 * サーバー側エージェントウォレットを作成（または alias で取得）し、アドレスと残高を表示する。
 * staging では --fund <USDXM> でテストトークンを入れる（stagingFund。本番では使えない）。
 *
 *   npm run wallet:setup
 *   npm run wallet:setup -- --fund 5
 */
import { createPublicClient, erc20Abi, http } from 'viem';
import { base, baseSepolia } from 'viem/chains';
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

try {
  const balances = await aw.wallet.balances(aw.env === 'staging' ? ['usdxm'] : []);
  console.log('残高:', JSON.stringify(balances, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
} catch (e) {
  // キーに wallets:balance.read が無いときは、チェーンから USDC の残高を直接読む
  console.log(`Crossmint の残高 API が使えない（${(e as Error).message.slice(0, 120)}）。チェーンから読む`);
  const chain = aw.chain === 'base' ? base : baseSepolia;
  const usdc = aw.chain === 'base' ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const raw = await createPublicClient({ chain, transport: http() }).readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [aw.address] });
  console.log(`USDC 残高（${aw.chain}、チェーン）: ${Number(raw) / 1e6}`);
}
