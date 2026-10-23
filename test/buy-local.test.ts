import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { ClientEvmSigner } from '@x402/evm';
import { startLocalX402Server } from '../src/x402/local-server.ts';
import { buyOnce, signedSpendForDay } from '../src/x402/buyer.ts';
import { loadAssets } from '../src/x402/requirements.ts';
import { SpendGuard } from '../src/caps.ts';
import { usdToMicro } from '../src/money.ts';
import { jstDay, readDay } from '../src/log.ts';

// Crossmint の代わりに viem のローカル鍵で署名する（402 → 署名 → 再送 の流れだけを確かめる）
const account = privateKeyToAccount(generatePrivateKey());
let signCount = 0;
const signer: ClientEvmSigner = {
  address: account.address,
  signTypedData: async (t) => {
    signCount++;
    return account.signTypedData(t as Parameters<typeof account.signTypedData>[0]);
  },
};

const dir = mkdtempSync(join(tmpdir(), 'cm-buyer-'));
process.env.LOG_DIR = join(dir, 'logs');
process.env.NODE_ENV = 'development';
const assets = loadAssets();
let evm: { server: Server; url: string };
let sol: { server: Server; url: string };

before(async () => {
  evm = await startLocalX402Server({ port: 0, mode: 'evm', verify: 'offline' });
  sol = await startLocalX402Server({ port: 0, mode: 'jin-solana', verify: 'offline' });
});
after(() => {
  evm.server.close();
  sol.server.close();
});

const params = (guard: SpendGuard) => ({
  signer,
  walletNetwork: 'eip155:84532',
  payer: account.address,
  guard,
  assets,
  env: 'test',
  target: 'local',
  outDir: join(dir, 'out'),
});

test('series・movers を1回ずつ買える（402 → 署名 → 再送）', async () => {
  const guard = new SpendGuard(usdToMicro('0.05'), usdToMicro('0.50'));
  const s = await buyOnce({ ...params(guard), url: `${evm.url}/api/jin/series`, expectedUsd: '0.01' });
  const m = await buyOnce({ ...params(guard), url: `${evm.url}/api/jin/movers`, expectedUsd: '0.02' });
  for (const r of [s, m]) {
    assert.equal(r.status, 200);
    assert.equal(r.entry.result, 'success', r.entry.error ?? '');
    assert.match(r.entry.tx ?? '', /^local-mock-/);
    assert.equal(r.entry.network, 'eip155:84532');
    assert.equal(r.entry.payer, account.address);
    assert.ok(r.bodyFile && existsSync(r.bodyFile));
  }
  assert.equal(m.entry.amount, '0.02');
  assert.equal(JSON.parse(readFileSync(s.bodyFile!, 'utf8')).endpoint, 'series');
  const day = readDay(jstDay());
  assert.equal(day.length, 2);
  assert.equal(signedSpendForDay(jstDay()), usdToMicro('0.03'));
});

test('JIN と同じ Solana の 402 には署名しない', async () => {
  const before = signCount;
  const guard = new SpendGuard(usdToMicro('0.05'), usdToMicro('0.50'));
  const r = await buyOnce({ ...params(guard), url: `${sol.url}/api/jin/series`, expectedUsd: '0.01' });
  assert.equal(r.entry.result, 'failure');
  assert.match(r.entry.error ?? '', /^not_payable_by_crossmint/);
  assert.equal(r.entry.network, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  assert.equal(signCount, before);
});

test('上限を超える 402 には署名しない', async () => {
  const before = signCount;
  const guard = new SpendGuard(usdToMicro('0.01'), usdToMicro('0.50'));
  const r = await buyOnce({ ...params(guard), url: `${evm.url}/api/jin/movers`, expectedUsd: '0.02' });
  assert.match(r.entry.error ?? '', /^per_call_cap/);
  const daily = new SpendGuard(usdToMicro('0.05'), usdToMicro('0.02'));
  await buyOnce({ ...params(daily), url: `${evm.url}/api/jin/series`, expectedUsd: '0.01' });
  const r2 = await buyOnce({ ...params(daily), url: `${evm.url}/api/jin/movers`, expectedUsd: '0.02' });
  assert.match(r2.entry.error ?? '', /^daily_cap/);
  assert.equal(signCount, before + 1);
});

test('402 の金額が想定と違えば署名しない', async () => {
  const before = signCount;
  const guard = new SpendGuard(usdToMicro('0.05'), usdToMicro('0.50'));
  const r = await buyOnce({ ...params(guard), url: `${evm.url}/api/jin/series`, expectedUsd: '0.02' });
  assert.match(r.entry.error ?? '', /^price_mismatch/);
  assert.equal(signCount, before);
});

test('ログに秘密になりうる項目が無い', () => {
  for (const e of readDay(jstDay())) {
    const keys = Object.keys(e).concat(Object.keys(e.ref ?? {}));
    for (const k of keys) assert.doesNotMatch(k, /secret|key|jwt|card|cvc|number/i);
  }
});
