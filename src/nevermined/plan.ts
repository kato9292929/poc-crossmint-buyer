import { Payments } from '@nevermined-io/payments';
import { optional, required } from '../config.ts';

/**
 * 実証1（poc-card-credits）の Nevermined プリペイドプラン。値は実証1の config/sandbox.json（公開値）と同じ。
 * 買い手のキー（NVM_API_KEY_BUYER）で orderFiatPlan を呼ぶと Stripe の PaymentIntent が返り、それをカードで支払う（docs/phase0.md）。
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
  // 環境はキーの接頭辞から SDK が決める（environment を渡すと非推奨の警告が出る）
  return { environment, payments: Payments.getInstance({ nvmApiKey: key } as Parameters<typeof Payments.getInstance>[0]) };
}

export async function planBalance(): Promise<{ balance: bigint; holder: string }> {
  const { payments } = buyerPayments();
  const b = await payments.plans.getPlanBalance(PLAN.planId);
  return { balance: BigInt(b.balance), holder: b.holderAddress };
}

/**
 * 実証1のプランの支払いを始める。orderFiatPlan（SDK 1.13.0）は、2026-10-30 時点で Stripe Checkout の URL ではなく
 * Stripe の PaymentIntent（client_secret つき、テストモード）を返す。client_secret は呼び出し側で支払いに使うだけで、ログには出さない。
 */
export async function createPaymentIntent(): Promise<{ paymentIntentId: string; clientSecret: string; amount: number; currency: string }> {
  const { payments } = buyerPayments();
  const raw = (await payments.plans.orderFiatPlan(PLAN.planId)) as unknown as Record<string, unknown>;
  const r = ((raw?.result as Record<string, unknown>) ?? raw) as Record<string, unknown>;
  if (r.object !== 'payment_intent' || typeof r.client_secret !== 'string' || typeof r.id !== 'string') {
    throw new Error(`orderFiatPlan の応答が PaymentIntent ではない: keys=${Object.keys(r).join(',')}`);
  }
  return { paymentIntentId: r.id, clientSecret: r.client_secret, amount: Number(r.amount), currency: String(r.currency) };
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
