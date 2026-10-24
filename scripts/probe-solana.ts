/**
 * フェーズ0-2 の確認（staging のキーが要る）：Crossmint の Solana のサーバー側ウォレットで、
 * x402 の Solana（exact）の支払いに必要な「部分署名したトランザクションを返す」ことができるかを確かめる。
 *
 *   npm run probe:solana
 *
 * やること（資金は動かさない）:
 *  1. Solana（staging = devnet）のサーバー側ウォレットを alias で作成／取得し、アドレスを記録する
 *  2. SDK の SolanaWallet が持つメソッドを列挙する（signTransaction / signMessage の有無）
 *  3. REST の署名 API（POST /api/2025-06-09/wallets/{locator}/signatures）に Solana のウォレットで1回だけリクエストし、
 *     応答をそのまま記録する（キーは伏せる）
 * 結果は out/probe-solana-<日時>.json に保存し、docs/blockers.md の A-1 に転記する。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { SolanaWallet } from '@crossmint/wallets-sdk';
import { crossmintBaseUrl, required } from '../src/config.ts';
import { WALLET_ALIAS, crossmintClient } from '../src/crossmint/wallet.ts';
import { redact } from '../src/redact.ts';

const { env, wallets } = crossmintClient();
if (env !== 'staging') throw new Error('この確認は staging のキーで行う');
const secret = required('CROSSMINT_SIGNER_SECRET');
const alias = `${WALLET_ALIAS}-sol`;

let wallet;
try {
  wallet = await wallets.getWallet(`solana:alias:${alias}`, { chain: 'solana' });
} catch {
  wallet = await wallets.createWallet({ chain: 'solana', recoveryMethods: [{ type: 'server', secret }], alias });
}
await wallet.useSigner({ type: 'server', secret });
const sol = SolanaWallet.from(wallet);

const proto = Object.getPrototypeOf(sol);
const methods = new Set<string>();
for (let p = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
  for (const k of Object.getOwnPropertyNames(p)) if (k !== 'constructor') methods.add(k);
}

const endpoint = `${crossmintBaseUrl(env)}/api/2025-06-09/wallets/${encodeURIComponent(`solana:alias:${alias}`)}/signatures`;
const body = { type: 'message', params: { message: 'x402 exact (svm) probe: can this wallet sign?' } };
const res = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'X-API-KEY': required('CROSSMINT_SERVER_API_KEY') },
  body: JSON.stringify(body),
});
const resText = await res.text();

// devnet 上のアカウントの所有プログラム（スマートウォレットかどうか）
const acct = await fetch('https://api.devnet.solana.com', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [wallet.address, { encoding: 'base64' }] }),
})
  .then((r) => r.json())
  .catch((e) => ({ error: String(e) }));

const record = {
  checkedAt: new Date().toISOString(),
  env,
  sdk: '@crossmint/wallets-sdk 1.20.4',
  wallet: { address: wallet.address, alias, chain: 'solana' },
  solanaWalletMethods: [...methods].sort(),
  hasSignTransaction: methods.has('signTransaction'),
  hasSignMessage: methods.has('signMessage'),
  restSignature: { request: { method: 'POST', url: endpoint, headers: { 'X-API-KEY': '***' }, body }, status: res.status, body: redact(resText) },
  devnetAccountInfo: acct,
};
mkdirSync('out', { recursive: true });
const file = `out/probe-solana-${record.checkedAt.replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 2));
console.log(`保存: ${file}`);

// Crossmint のスレッドにそのまま貼る文面（英語）。キーは伏せてある
const mail = [
  `Solana wallet probe (${env}, ${record.checkedAt}, ${record.sdk})`,
  '',
  `Wallet: ${wallet.address} (server signer, alias "${alias}", chain "solana")`,
  `SolanaWallet methods: ${record.solanaWalletMethods.join(', ')}`,
  `signTransaction: ${record.hasSignTransaction ? 'present' : 'absent'} / signMessage: ${record.hasSignMessage ? 'present' : 'absent'}`,
  '',
  'Request:',
  `POST ${endpoint}`,
  'X-API-KEY: <server key, redacted>',
  JSON.stringify(body),
  '',
  `Response: HTTP ${res.status}`,
  redact(resText),
  '',
].join('\n');
const mailFile = file.replace(/\.json$/, '.md');
writeFileSync(mailFile, mail);
console.log(`\n--- スレッドに貼る文面（${mailFile}） ---\n${mail}`);
