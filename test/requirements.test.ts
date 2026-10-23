import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PaymentRequired } from '@x402/core/types';
import { loadAssets, selectRequirements } from '../src/x402/requirements.ts';

const jin = JSON.parse(readFileSync(new URL('./fixtures/jin-402-series.json', import.meta.url), 'utf8')) as PaymentRequired;
const assets = loadAssets();

test('JIN の 402（Solana mainnet USDC だけ）は Crossmint のウォレットでは払えない', () => {
  for (const net of ['eip155:8453', 'eip155:84532']) {
    const s = selectRequirements(jin, net, assets);
    assert.equal(s.ok, false);
    assert.equal(!s.ok && s.reason, 'not_payable_by_crossmint');
  }
});

test('Base の USDC があれば、ウォレットのネットワークに合うものを選ぶ', () => {
  const pr: PaymentRequired = {
    ...jin,
    accepts: [
      ...jin.accepts,
      { scheme: 'exact', network: 'eip155:8453', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '10000', payTo: '0x000000000000000000000000000000000000dEaD', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } },
    ],
  };
  const s = selectRequirements(pr, 'eip155:8453', assets);
  assert.ok(s.ok);
  assert.equal(s.ok && s.amountMicro, 10_000n);
  const t = selectRequirements(pr, 'eip155:84532', assets);
  assert.equal(!t.ok && t.reason, 'network_mismatch');
});

test('許可していない資産には払わない', () => {
  const pr: PaymentRequired = { ...jin, accepts: [{ ...jin.accepts[0], asset: 'So11111111111111111111111111111111111111112' }] };
  const s = selectRequirements(pr, 'eip155:8453', assets);
  assert.equal(!s.ok && s.reason, 'no_allowed_asset');
});
