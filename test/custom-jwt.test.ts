import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { JWKS_FILE, JWT_SUBJECT, issueUserJwt, writeJwks } from '../src/crossmint/custom-jwt.ts';
import * as cm from '@crossmint/common-sdk-base';

test('発行した JWT は、コミットした jwks.json の公開鍵で検証でき、Crossmint が求める claim を持つ', async (t) => {
  if (!process.env.CROSSMINT_CLIENT_API_KEY) return t.skip('CROSSMINT_CLIENT_API_KEY が無い（project ID を取れない）');
  await writeJwks();
  const jwks = createLocalJWKSet(JSON.parse(readFileSync(JWKS_FILE, 'utf8')));
  const jwt = await issueUserJwt(process.env.CROSSMINT_CLIENT_API_KEY);
  const { payload, protectedHeader } = await jwtVerify(jwt, jwks, { audience: 'crossmint.com' });
  assert.equal(protectedHeader.alg, 'RS256');
  assert.equal(payload.sub, JWT_SUBJECT);
  const r = cm.validateAPIKey(process.env.CROSSMINT_CLIENT_API_KEY);
  assert.ok(r.isValid && payload.iss === r.projectId);
});

test('jwks.json に秘密鍵の成分が入っていない', () => {
  const k = JSON.parse(readFileSync(JWKS_FILE, 'utf8')).keys[0];
  for (const priv of ['d', 'p', 'q', 'dp', 'dq', 'qi']) assert.equal(k[priv], undefined);
  assert.equal(k.kty, 'RSA');
  assert.ok(k.kid);
});
