import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, calculateJwkThumbprint, exportJWK, importPKCS8, importSPKI } from 'jose';
import { validateAPIKey } from '@crossmint/common-sdk-base';

/**
 * Crossmint の「Custom tokens」（独自 JWT）で、カード利用者の JWT をこのセッションの中で発行する。
 * 人のメールのワンタイムコードは要らない。staging 専用（カード利用者は staging のテストユーザー1人だけ）。
 *
 * - 署名鍵（RS256）は .secrets/jwt-private.pem に置く（コミットしない）。無ければ作る。
 *   環境変数 CROSSMINT_JWT_PRIVATE_KEY（PKCS8 の PEM を base64）があればそちらを使う。
 * - 公開鍵は web/public/jwks.json に書き出してコミットする。Crossmint は公開リポジトリの raw の URL から読む。
 *   鍵を作り直したら jwks.json を更新してプッシュすればよい（kid で区別する）。
 */
export const JWT_SUBJECT = process.env.CROSSMINT_JWT_SUBJECT ?? 'poc-crossmint-buyer-card-user';
const KEY_FILE = '.secrets/jwt-private.pem';
export const JWKS_FILE = 'web/public/jwks.json';
export const JWKS_URL =
  process.env.CROSSMINT_JWKS_URL ?? 'https://raw.githubusercontent.com/kato9292929/poc-crossmint-buyer/claude/festive-rubin-vtr563/web/public/jwks.json';

function privatePem(): string {
  const fromEnv = process.env.CROSSMINT_JWT_PRIVATE_KEY;
  if (fromEnv) return Buffer.from(fromEnv, 'base64').toString('utf8');
  if (!existsSync(KEY_FILE)) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    mkdirSync('.secrets', { recursive: true });
    writeFileSync(KEY_FILE, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  }
  return readFileSync(KEY_FILE, 'utf8');
}

async function keys() {
  const pem = privatePem();
  const { createPublicKey } = await import('node:crypto');
  const spki = createPublicKey(pem).export({ format: 'pem', type: 'spki' }).toString();
  const publicJwk = await exportJWK(await importSPKI(spki, 'RS256', { extractable: true }));
  const kid = await calculateJwkThumbprint(publicJwk);
  return { privateKey: await importPKCS8(pem, 'RS256'), publicJwk: { ...publicJwk, kid, alg: 'RS256', use: 'sig' }, kid };
}

export async function jwks() {
  const { publicJwk } = await keys();
  return { keys: [publicJwk] };
}

/** web/public/jwks.json を今の鍵に合わせる。変わったら true（コミット・プッシュが要る）。 */
export async function writeJwks(): Promise<boolean> {
  const next = JSON.stringify(await jwks(), null, 2) + '\n';
  const prev = existsSync(JWKS_FILE) ? readFileSync(JWKS_FILE, 'utf8') : '';
  if (prev === next) return false;
  mkdirSync('web/public', { recursive: true });
  writeFileSync(JWKS_FILE, next);
  return true;
}

export function projectIdFromKey(apiKey: string): string {
  const r = validateAPIKey(apiKey);
  if (!r.isValid) throw new Error('Crossmint の API キーから project ID を取り出せない');
  return r.projectId;
}

/** カード利用者の JWT（iss = project ID、aud = crossmint.com、1時間有効）。 */
export async function issueUserJwt(clientApiKey: string, subject = JWT_SUBJECT): Promise<string> {
  const { privateKey, kid } = await keys();
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(projectIdFromKey(clientApiKey))
    .setSubject(subject)
    .setAudience('crossmint.com')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}
