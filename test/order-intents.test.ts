import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompactEncrypt, importJWK } from 'jose';
import { CrossmintApiError, OrderIntentsClient, railNeedingVerification, selectRail, type OrderIntent } from '../src/crossmint/order-intents.ts';
import { recordBlocker } from '../src/blockers.ts';

const KEY = 'ck_staging_abcdefABCDEF1234567890';
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl';
const CARD = { number: '4000001000000000', expirationMonth: 12, expirationYear: 2030, cvc: '123' };

function oi(rails: OrderIntent['rails']): OrderIntent {
  return {
    orderIntentId: 'oi_1',
    paymentMethodId: 'pm_1',
    status: 'active',
    amount: { total: '1.00', spent: '0.00', reserved: '0.00', available: '1.00', currency: 'USD' },
    description: 'test',
    rails,
    expiresAt: '2099-01-01T00:00:00Z',
  };
}

test('rail の選び方：active なカードネットワーク → encrypted-card。pending なら検証が要る', () => {
  const pending = [{ rail: 'agentic-token', provider: 'vic', status: 'pending_verification', credentialFormats: ['card'] }];
  assert.equal(selectRail(pending), undefined);
  assert.equal(railNeedingVerification(pending)?.provider, 'vic');
  const both = [{ rail: 'agentic-token', provider: 'vic', status: 'error', credentialFormats: [] }, { rail: 'encrypted-card', status: 'active', credentialFormats: ['card'] }];
  assert.equal(selectRail(both)?.rail, 'encrypted-card');
  // staging の実際の応答：VIC が検証待ちでも encrypted-card と spt は最初から active。この場合は VIC の検証を先に通す
  const staging = [pending[0], { rail: 'spt', provider: 'stripe', status: 'active', credentialFormats: ['identifier'] }, both[1]];
  assert.equal(selectRail(staging), undefined);
  assert.equal(railNeedingVerification(staging)?.provider, 'vic');
  const active = [{ ...pending[0], status: 'active' }, both[1]];
  assert.equal(selectRail(active)?.rail, 'agentic-token');
});

test('API の失敗は、キーと JWT を伏せて CrossmintApiError にする', async () => {
  const f = (async () => new Response(JSON.stringify({ error: 'forbidden', echo: KEY, token: JWT }), { status: 403 })) as typeof fetch;
  const c = new OrderIntentsClient('staging', KEY, JWT, f);
  await assert.rejects(
    c.createOrderIntent({ paymentMethodId: 'pm_1', amount: { value: '1.00', currency: 'USD' }, merchant: { name: 'N', url: 'https://n', countryCode: 'US' }, description: 'd', expiresAt: '2099-01-01T00:00:00Z' }),
    (e: unknown) => {
      assert.ok(e instanceof CrossmintApiError);
      assert.equal(e.failure.status, 403);
      assert.match(e.failure.endpoint, /\/api\/unstable\/order-intents$/);
      assert.doesNotMatch(e.failure.responseBody, /abcdefABCDEF|c2lnbmF0dXJl/);
      return true;
    },
  );
});

test('agentic-token のカード番号は CardCredential の外に出ない', async () => {
  let sent: Record<string, unknown> = {};
  const f = (async (_u: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    assert.equal((init.headers as Record<string, string>)['Idempotency-Key'], 'idem-1');
    return new Response(JSON.stringify({ id: 'cred_1', rail: 'agentic-token', provider: 'vic', amount: { value: '1.00', currency: 'USD' }, credential: { format: 'card', value: CARD }, expiresAt: '2099-01-01T00:05:00Z' }));
  }) as typeof fetch;
  const c = new OrderIntentsClient('staging', KEY, JWT, f);
  const cred = await c.mintCard(oi([{ rail: 'agentic-token', provider: 'vic', status: 'active', credentialFormats: ['card'] }]), '1.00', 'idem-1');
  assert.deepEqual(sent, { rail: 'agentic-token', provider: 'vic', amount: { value: '1.00', currency: 'USD' }, credential: { format: 'card' } });
  assert.doesNotMatch(JSON.stringify(cred) + String(cred), /4000001000000000|123/);
  assert.equal(cred.use((v) => v.number), CARD.number);
  cred.wipe();
  assert.throws(() => cred.use((v) => v.number));
});

test('encrypted-card は、その場で作った RSA 鍵で復号する', async () => {
  const f = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.rail, 'encrypted-card');
    assert.equal(body.provider, undefined);
    assert.deepEqual(Object.keys(body.credential.publicKey).sort(), ['e', 'kty', 'n']);
    const pub = await importJWK({ ...body.credential.publicKey, alg: 'RSA-OAEP-256' }, 'RSA-OAEP-256');
    const jwe = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify(CARD))).setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM' }).encrypt(pub);
    return new Response(JSON.stringify({ id: 'cred_2', rail: 'encrypted-card', amount: { value: '1.00', currency: 'USD' }, credential: { format: 'card', value: jwe }, expiresAt: '2099-01-01T00:05:00Z' }));
  }) as typeof fetch;
  const c = new OrderIntentsClient('staging', KEY, JWT, f);
  const cred = await c.mintCard(oi([{ rail: 'encrypted-card', status: 'active', credentialFormats: ['card'] }]), '1.00', 'idem-2');
  assert.equal(cred.meta.rail, 'encrypted-card');
  assert.equal(cred.use((v) => `${v.number}/${v.cvc}`), '4000001000000000/123');
});

test('blockers.md への記録はキー・JWT を伏せる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blk-'));
  const file = join(dir, 'blockers.md');
  writeFileSync(file, '# blockers\n');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    recordBlocker('テスト', { endpoint: 'https://staging.crossmint.com/api/unstable/order-intents', method: 'POST', requestBody: { k: KEY, jwt: JWT }, status: 403, responseBody: `{"message":"no access ${KEY}"}` }, file);
  } finally {
    process.chdir(cwd);
  }
  const md = readFileSync(file, 'utf8');
  assert.match(md, /POST https:\/\/staging\.crossmint\.com\/api\/unstable\/order-intents/);
  assert.match(md, /403/);
  assert.doesNotMatch(md, /abcdefABCDEF|c2lnbmF0dXJl/);
});
