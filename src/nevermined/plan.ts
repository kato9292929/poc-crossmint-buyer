import { Payments } from '@nevermined-io/payments';
import { optional, required } from '../config.ts';

/**
 * 実証1（poc-card-credits）の Nevermined プリペイドプラン。値は実証1の config/sandbox.json（公開値）と同じ。
 * 買い手のキー（NVM_API_KEY_BUYER）で orderFiatPlan を呼ぶと Stripe Checkout の URL が返る。
 * Nevermined にはカード番号を API で渡して買う経路が無く、カードを入れられるのはこの Stripe Checkout のページだけ（docs/phase0.md）。
 */
export const PLAN = {
  name: 'prepaid-100',
  priceUsd: '1.00',
  credits: 100,
  planId: optional('NVM_PLAN_ID') ?? '61852813790907981549543018232399411968336511683982723564743066269725851774087',
} as const;

export type NvmEnvironment = 'sandbox' | 'live';

export function nvmEnvironment(apiKey: string): NvmEnvironment {
  const prefix = apiKey.split(':')[0];
  if (prefix !== 'sandbox' && prefix !== 'live') throw new Error('NVM_API_KEY_BUYER の接頭辞が sandbox: / live: でない');
  if (prefix === 'live') throw new Error('実証1のプランは Sandbox だけ（live のキーでは動かさない）');
  return prefix;
}

export function buyerPayments() {
  const key = required('NVM_API_KEY_BUYER');
  const environment = nvmEnvironment(key);
  return { environment, payments: Payments.getInstance({ nvmApiKey: key, environment }) };
}

export async function planBalance(): Promise<{ balance: bigint; holder: string }> {
  const { payments } = buyerPayments();
  const b = await payments.plans.getPlanBalance(PLAN.planId);
  return { balance: BigInt(b.balance), holder: b.holderAddress };
}

export async function createCheckout(): Promise<{ checkoutLink: string; sessionId: string | null }> {
  const { payments } = buyerPayments();
  const raw = (await payments.plans.orderFiatPlan(PLAN.planId)) as unknown as { result?: Record<string, unknown> } & Record<string, unknown>;
  // 実証1と同じく、戻り値の形が型と違う場合に備えて URL を探す
  const r = (raw?.result ?? raw) as Record<string, unknown>;
  const link = (r.checkoutLink ?? r.url ?? r.checkoutUrl) as string | undefined;
  if (!link || !/^https:\/\//.test(link)) throw new Error(`orderFiatPlan の応答に checkout の URL が無い: keys=${Object.keys(r).join(',')}`);
  return { checkoutLink: link, sessionId: (r.stripeCheckoutSessionId ?? r.sessionId ?? null) as string | null };
}

/**
 * 買い手のキーから、Nevermined 上の買い手の識別子を取り出す（キーそのものは出さない）。
 * キーは「環境:JWT」の形で、JWT の中身に userId（sub）とアカウントのアドレスが入っている。実証2の nvm_user_hashes の元になる値。
 */
export function buyerIdentity(): { userId: string | null; accountAddress: string | null } {
  const key = required('NVM_API_KEY_BUYER');
  const { payments } = buyerPayments();
  let userId: string | null = null;
  try {
    const jwt = key.slice(key.indexOf(':') + 1);
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    userId = typeof payload.sub === 'string' ? payload.sub : typeof payload.userId === 'string' ? payload.userId : null;
  } catch {
    userId = null;
  }
  return { userId, accountAddress: payments.getAccountAddress() ?? null };
}
