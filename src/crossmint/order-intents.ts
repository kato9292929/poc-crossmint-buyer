import { generateKeyPairSync } from 'node:crypto';
import { compactDecrypt, importJWK } from 'jose';
import { crossmintBaseUrl, type CrossmintEnv } from '../config.ts';
import { redact } from '../redact.ts';

/**
 * Crossmint エージェントカードの REST（クライアントキー＋利用者の JWT）。
 * order intent の API は /api/unstable/ 配下（早期アクセス）。失敗したときは、
 * エンドポイント・リクエスト・レスポンスを伏せ字にして ApiFailure に入れ、呼び出し側が docs/blockers.md に残す。
 *
 * カード番号（credential の応答本文）は、この層から外へ文字列として出さない。mintCard() が返す CardCredential だけが持ち、
 * ログ・例外メッセージ・ApiFailure には入れない。
 */
export interface OrderIntentRail {
  rail: 'agentic-token' | 'encrypted-card' | 'spt' | string;
  provider?: string;
  status: string;
  credentialFormats?: string[];
  error?: { code: string };
}

export interface OrderIntent {
  orderIntentId: string;
  paymentMethodId: string;
  status: string;
  amount: { total: string; spent: string; reserved: string; available: string; currency: string };
  merchant?: { name: string; url: string; countryCode: string };
  description: string;
  rails: OrderIntentRail[];
  verificationConfig?: unknown;
  expiresAt: string;
}

export interface ApiFailure {
  endpoint: string;
  method: string;
  requestBody: unknown;
  status: number;
  responseBody: string;
}

export class CrossmintApiError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(`${failure.method} ${failure.endpoint} → ${failure.status}: ${failure.responseBody.slice(0, 500)}`);
  }
}

/** カードの認証情報。使い終わったら wipe() する。toJSON・toString では中身を出さない。 */
export class CardCredential {
  #v: { number: string; expirationMonth: number; expirationYear: number; cvc: string } | null;
  constructor(
    v: { number: string; expirationMonth: number; expirationYear: number; cvc: string },
    readonly meta: { id: string; rail: string; provider?: string; amount: string; expiresAt: string },
  ) {
    this.#v = v;
  }
  use<T>(fn: (v: { number: string; expirationMonth: number; expirationYear: number; cvc: string }) => T): T {
    if (!this.#v) throw new Error('credential は破棄済み');
    return fn(this.#v);
  }
  wipe(): void {
    this.#v = null;
  }
  toJSON() {
    return { credential: '[redacted]', ...this.meta };
  }
  toString() {
    return '[CardCredential redacted]';
  }
}

export interface Merchant {
  name: string;
  url: string;
  countryCode: string;
}

export class OrderIntentsClient {
  private readonly base: string;
  constructor(
    readonly env: CrossmintEnv,
    private readonly clientApiKey: string,
    private readonly jwt: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = crossmintBaseUrl(env);
  }

  private async call<T>(method: string, path: string, body?: unknown, opts: { secretResponse?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'X-API-KEY': this.clientApiKey,
        Authorization: `Bearer ${this.jwt}`,
        ...opts.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new CrossmintApiError({
        endpoint: `${this.base}${path}`,
        method,
        requestBody: body === undefined ? null : JSON.parse(redact(JSON.stringify(body))),
        status: res.status,
        // 失敗した応答にはカード情報は入らないが、念のため長い数字列は伏せる
        responseBody: redact(text),
      });
    }
    if (opts.secretResponse) return JSON.parse(text) as T;
    return (text ? JSON.parse(text) : null) as T;
  }

  /** カードを order intent 用に登録する（エージェント用の認証の準備。利用者の承認は要らない）。 */
  registerCard(paymentMethodId: string, consumer: { email: string; countryCode: string; languageCode: string }) {
    return this.call<{ paymentMethodId: string; rails: OrderIntentRail[] }>(
      'PUT',
      `/api/2026-09-16/payment-methods/${encodeURIComponent(paymentMethodId)}/order-intent-registration`,
      consumer,
    );
  }

  createOrderIntent(input: { paymentMethodId: string; amount: { value: string; currency: string }; merchant: Merchant; description: string; expiresAt: string }) {
    return this.call<OrderIntent>('POST', '/api/unstable/order-intents', input);
  }

  getOrderIntent(id: string) {
    return this.call<OrderIntent>('GET', `/api/unstable/order-intents/${encodeURIComponent(id)}`);
  }

  revokeOrderIntent(id: string) {
    return this.call<unknown>('DELETE', `/api/unstable/order-intents/${encodeURIComponent(id)}`);
  }

  /**
   * 1回分のカード番号を取得する（minting は order intent の枠を消費する。再試行しない）。
   * カードネットワークのレール（agentic-token）が active ならそれを使い、無ければ encrypted-card を使う。
   */
  async mintCard(oi: OrderIntent, amount: string, idempotencyKey: string): Promise<CardCredential> {
    const rail = selectRail(oi.rails);
    if (!rail) throw new Error(`使える rail が無い: ${JSON.stringify(oi.rails)}`);
    const headers = { 'Idempotency-Key': idempotencyKey };
    const path = `/api/unstable/order-intents/${encodeURIComponent(oi.orderIntentId)}/credentials`;
    if (rail.rail === 'agentic-token') {
      const r = await this.call<CredentialResponse>(
        'POST',
        path,
        { rail: rail.rail, provider: rail.provider, amount: { value: amount, currency: oi.amount.currency }, credential: { format: 'card' } },
        { secretResponse: true, headers },
      );
      if (typeof r.credential.value === 'string') throw new Error('agentic-token の応答の形が想定外');
      return new CardCredential(r.credential.value, { id: r.id, rail: r.rail, provider: r.provider, amount: r.amount.value, expiresAt: r.expiresAt });
    }
    // encrypted-card: RSA の鍵をこのプロセスの中だけで作り、使い終わったら捨てる
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    const r = await this.call<CredentialResponse>(
      'POST',
      path,
      { rail: 'encrypted-card', amount: { value: amount, currency: oi.amount.currency }, credential: { format: 'card', publicKey: { kty: jwk.kty, n: jwk.n, e: jwk.e } } },
      { secretResponse: true, headers },
    );
    if (typeof r.credential.value !== 'string') throw new Error('encrypted-card の応答の形が想定外');
    const key = await importJWK(privateKey.export({ format: 'jwk' }) as Record<string, string>, 'RSA-OAEP-256');
    const { plaintext } = await compactDecrypt(r.credential.value, key);
    return new CardCredential(JSON.parse(new TextDecoder().decode(plaintext)), { id: r.id, rail: r.rail, amount: r.amount.value, expiresAt: r.expiresAt });
  }
}

interface CredentialResponse {
  id: string;
  rail: string;
  provider?: string;
  amount: { value: string; currency: string };
  credential: { format: string; value: string | { number: string; expirationMonth: number; expirationYear: number; cvc: string } };
  expiresAt: string;
}

/**
 * ドキュメントの方針どおり、カードネットワークのレール（agentic-token）を優先する。
 * agentic-token が検証待ち（pending_verification）なら、encrypted-card が active でも選ばずに検証を先に通す。
 * encrypted-card を使うのは、カードネットワークのレールが無いか error のときだけ。
 */
export function selectRail(rails: OrderIntentRail[]): OrderIntentRail | undefined {
  const network = rails.filter((r) => r.rail === 'agentic-token' && (r.credentialFormats ?? []).includes('card'));
  const active = network.find((r) => r.status === 'active');
  if (active) return active;
  if (network.some((r) => r.status === 'pending_verification')) return undefined;
  return rails.find((r) => r.rail === 'encrypted-card' && r.status === 'active');
}

/** 検証が要るレール（OrderIntentVerification を出す対象）。 */
export function railNeedingVerification(rails: OrderIntentRail[]): OrderIntentRail | undefined {
  if (selectRail(rails)) return undefined;
  return rails.find((r) => r.rail === 'agentic-token' && r.status === 'pending_verification');
}
