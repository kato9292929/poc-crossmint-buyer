import { readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { recordBlocker } from './blockers.ts';
import { CrossmintApiError, OrderIntentsClient, selectRail } from './crossmint/order-intents.ts';
import { appendPurchase, baseEntry, fileLoggingEnabled, logDir, readDay, type PurchaseLogEntry } from './log.ts';
import { PLAN, buyerPayments, createPaymentIntent, planBalance } from './nevermined/plan.ts';
import { fetchNeverminedStripeKey, payPaymentIntent } from './stripe-elements.ts';

export interface CardPurchaseInput {
  client: OrderIntentsClient;
  orderIntentId: string;
  buyer: { email: string; name: string; postalCode?: string; country?: string };
  force?: boolean;
  headless?: boolean;
}

/** フェーズBの購入は1回だけ（同じ環境で成功が記録済みなら止める）。 */
export function alreadyPurchased(env: string): boolean {
  let files: string[] = [];
  try {
    files = readdirSync(logDir()).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    return false;
  }
  return files.some((f) => readDay(f.slice(0, 10)).some((e) => e.phase === 'B' && e.env === env && e.result === 'success'));
}

/**
 * Crossmint の order intent から1回分のカード番号を取り、実証1の Nevermined プリペイドプラン（prepaid-100、$1）を1回買う。
 * 1. order intent の rail を確かめる（active なカードネットワークのレール、無ければ encrypted-card）
 * 2. Nevermined の買い手のキーで、プランの Stripe の PaymentIntent を作る
 * 3. カード番号を $1.00 分だけ取得し、Stripe Elements（Stripe のカード入力欄）に入れて PaymentIntent を支払う（番号はどこにも残さない）
 * 4. Nevermined の残高が増えたことを確かめる（最大5分）
 */
export async function purchasePlanWithCard(input: CardPurchaseInput): Promise<PurchaseLogEntry> {
  const { client } = input;
  const env = `crossmint-${client.env}/nvm-${buyerPayments().environment}`;
  const started = new Date();
  const ref: Record<string, string | number | boolean | null> = { crossmintEnv: client.env, planId: PLAN.planId };
  const finish = (result: 'success' | 'failure', error: string | null, tx: string | null): PurchaseLogEntry => {
    const entry: PurchaseLogEntry = {
      ...baseEntry(started),
      phase: 'B',
      buyer: 'crossmint-card',
      seller: 'nevermined',
      item: PLAN.name,
      amount: PLAN.priceUsd,
      currency: 'USD',
      network: 'card',
      payer: input.orderIntentId,
      tx,
      result,
      error,
      env,
      target: 'nevermined',
      ref,
    };
    appendPurchase(entry, started);
    return entry;
  };

  // 「1回だけ」はログファイルで判定するので、ファイル出力が無効なら購入しない
  if (!fileLoggingEnabled()) return finish('failure', 'logging_disabled: NODE_ENV=development で実行する（購入記録を残せないため）', null);
  if (!input.force && alreadyPurchased(env)) return finish('failure', 'already_purchased: この環境ではフェーズBの購入が記録済み（--force で再実行）', null);

  let step = 'order intent の取得';
  let sessionId: string | null = null;
  try {
    const oi = await client.getOrderIntent(input.orderIntentId);
    const rail = selectRail(oi.rails);
    ref.rails = JSON.stringify(oi.rails.map((r) => ({ rail: r.rail, provider: r.provider ?? null, status: r.status, error: r.error?.code ?? null })));
    ref.available = oi.amount.available;
    if (!rail) return finish('failure', `no_active_rail: 承認済みの rail が無い（${ref.rails}）`, null);
    if (Number(oi.amount.available) < Number(PLAN.priceUsd)) return finish('failure', `order_intent_amount: 残り $${oi.amount.available} < $${PLAN.priceUsd}`, null);
    ref.rail = rail.rail;
    ref.provider = rail.provider ?? null;

    step = 'Nevermined の PaymentIntent の作成';
    const before = await planBalance();
    ref.balanceBefore = before.balance.toString();
    const pi = await createPaymentIntent();
    sessionId = pi.paymentIntentId;
    if (pi.amount !== Math.round(Number(PLAN.priceUsd) * 100) || pi.currency !== 'usd') {
      return finish('failure', `price_mismatch: PaymentIntent は ${pi.amount} ${pi.currency}、想定は $${PLAN.priceUsd}`, sessionId);
    }
    const publishableKey = await fetchNeverminedStripeKey(buyerPayments().environment);

    step = 'カード番号の取得（order intent credentials）';
    const card = await client.mintCard(oi, PLAN.priceUsd, `${oi.orderIntentId}:${sessionId}`);
    ref.credentialId = card.meta.id;

    step = 'Stripe での支払い（PaymentIntent の確定）';
    const paid = await payPaymentIntent(publishableKey, pi.clientSecret, card, { email: input.buyer.email, name: input.buyer.name, postalCode: input.buyer.postalCode ?? '94105' }, { headless: input.headless });
    ref.paymentIntentStatus = paid.status;
    if (!paid.ok) return finish('failure', `stripe_payment_failed: ${paid.message ?? paid.status}`, sessionId);

    step = 'クレジット付与の確認';
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const b = await planBalance();
      if (b.balance >= before.balance + BigInt(PLAN.credits)) {
        ref.balanceAfter = b.balance.toString();
        ref.holder = b.holder;
        return finish('success', null, sessionId);
      }
      await sleep(5000);
    }
    return finish('failure', 'credits_not_granted: 支払い後5分以内にクレジットが付与されなかった', sessionId);
  } catch (e) {
    if (e instanceof CrossmintApiError) {
      recordBlocker(`フェーズB: ${step}`, e.failure);
      return finish('failure', `crossmint_api_error (${step}): ${e.failure.status} ${e.failure.responseBody.slice(0, 300)}`, sessionId);
    }
    return finish('failure', `${step}: ${(e as Error).message}`, sessionId);
  }
}
