import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import type { CardCredential } from './crossmint/order-intents.ts';
import { redact } from './redact.ts';

/**
 * Nevermined が作った Stripe の PaymentIntent を、Stripe Elements（Stripe 自身のカード入力欄）で支払う。
 *
 * Nevermined の orderFiatPlan は、Stripe Checkout の URL ではなく PaymentIntent（client_secret つき）を返すようになった
 * （2026-10-30 確認）。Nevermined App も同じ PaymentIntent を Stripe Elements で払っている。ここでは
 * localhost に Stripe Elements だけの最小のページを出し、取得したカード番号を Stripe の iframe の入力欄に入れて confirmCardPayment する。
 * カード番号は Stripe の iframe に入るだけで、ログ・標準出力・スクリーンショット・ファイルには残さない。
 */
export interface ElementsResult {
  ok: boolean;
  status: string | null;
  message: string | null;
}

const PAGE = (pk: string) => `<!doctype html><html><head><meta charset="utf-8"><script src="https://js.stripe.com/v3/"></script></head>
<body><div id="card" style="width:420px;padding:8px;border:1px solid #ccc"></div><div id="out"></div>
<script>
  const stripe = Stripe(${JSON.stringify(pk)});
  const card = stripe.elements().create('card', { hidePostalCode: false });
  card.mount('#card');
  window.__ready = new Promise((ok) => card.on('ready', ok));
  window.__confirm = async (clientSecret, billing) => {
    const r = await stripe.confirmCardPayment(clientSecret, { payment_method: { card, billing_details: billing } });
    return r.error ? { ok: false, status: r.error.payment_intent ? r.error.payment_intent.status : null, message: (r.error.code || '') + ': ' + r.error.message }
                   : { ok: r.paymentIntent.status === 'succeeded' || r.paymentIntent.status === 'processing', status: r.paymentIntent.status, message: null };
  };
</script></body></html>`;

function browserExecutable(): { executablePath?: string; channel?: string } {
  if (process.env.CHROMIUM_PATH) return { executablePath: process.env.CHROMIUM_PATH };
  const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  return existsSync(bundled) ? { executablePath: bundled } : { channel: 'chrome' };
}

export async function fetchNeverminedStripeKey(environment: 'sandbox' | 'live'): Promise<string> {
  if (process.env.NVM_STRIPE_PUBLISHABLE_KEY) return process.env.NVM_STRIPE_PUBLISHABLE_KEY;
  const r = await fetch('https://nevermined.app/api/config');
  const c = ((await r.json()) as { config: Record<string, string> }).config;
  const key = environment === 'sandbox' ? c.sandboxStripePublishableApiKey : c.liveStripePublishableApiKey;
  if (!key?.startsWith(environment === 'sandbox' ? 'pk_test_' : 'pk_live_')) throw new Error('Nevermined の Stripe の公開鍵が取れない');
  return key;
}

export async function payPaymentIntent(
  publishableKey: string,
  clientSecret: string,
  card: CardCredential,
  billing: { email: string; name: string; postalCode: string },
  opts: { headless?: boolean } = {},
): Promise<ElementsResult> {
  const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE(publishableKey)));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: opts.headless ?? true, ...browserExecutable() });
    const page = await browser.newPage({ locale: 'en-US' });
    page.setDefaultTimeout(30_000);
    await page.goto(`http://localhost:${port}/`);
    await page.evaluate(() => (window as unknown as { __ready: Promise<void> }).__ready);
    const frame = page.frameLocator('#card iframe').first();
    await card.use(async (c) => {
      await frame.locator('input[name="cardnumber"]').pressSequentially(c.number, { delay: 20 });
      await frame.locator('input[name="exp-date"]').pressSequentially(`${String(c.expirationMonth).padStart(2, '0')}${String(c.expirationYear % 100).padStart(2, '0')}`, { delay: 20 });
      await frame.locator('input[name="cvc"]').pressSequentially(c.cvc, { delay: 20 });
    });
    card.wipe();
    const postal = frame.locator('input[name="postal"]');
    if (await postal.count()) await postal.pressSequentially(billing.postalCode, { delay: 20 });
    const r = await page.evaluate(
      ([cs, b]) => (window as unknown as { __confirm: (cs: string, b: unknown) => Promise<ElementsResult> }).__confirm(cs, b),
      [clientSecret, { email: billing.email, name: billing.name, address: { postal_code: billing.postalCode } }] as const,
    );
    return { ...r, message: r.message ? redact(r.message) : null };
  } catch (e) {
    return { ok: false, status: null, message: redact(`exception: ${(e as Error).message}`.slice(0, 500)) };
  } finally {
    card.wipe();
    await browser?.close().catch(() => undefined);
    server.close();
  }
}
