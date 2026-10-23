import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { CardCredential } from './crossmint/order-intents.ts';
import { redact } from './redact.ts';

/**
 * Stripe Checkout（ホスト型）のページにカードを入れて支払う。
 * カード番号はページの入力欄に直接入れるだけで、ログ・標準出力・スクリーンショット・ファイルには残さない。
 * 失敗したときに返すのは、ページに出たエラーの文言（数字列は伏せる）と URL だけ。
 */
export interface CheckoutResult {
  ok: boolean;
  finalUrl: string;
  message: string | null;
}

function browserExecutable(): { executablePath?: string; channel?: string } {
  const env = process.env.CHROMIUM_PATH;
  if (env) return { executablePath: env };
  const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  if (existsSync(bundled)) return { executablePath: bundled };
  return { channel: 'chrome' }; // 手元の Mac / Windows では、インストール済みの Chrome を使う
}

async function fillIfVisible(page: Page, selector: string, value: string) {
  const el = page.locator(selector).first();
  if ((await el.count()) && (await el.isVisible()) && !(await el.inputValue().catch(() => ''))) await el.fill(value);
}

export async function payStripeCheckout(
  checkoutLink: string,
  card: CardCredential,
  buyer: { email: string; name: string; postalCode?: string; country?: string },
  opts: { headless?: boolean; timeoutMs?: number } = {},
): Promise<CheckoutResult> {
  const timeout = opts.timeoutMs ?? 90_000;
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: opts.headless ?? true, ...browserExecutable() });
    const page = await browser.newPage({ locale: 'en-US' });
    page.setDefaultTimeout(30_000);
    await page.goto(checkoutLink, { waitUntil: 'domcontentloaded' });

    // 支払い方法がアコーディオンで並ぶページでは、カードを選ぶ
    const cardTab = page.locator('[data-testid="card-accordion-item-button"], button[aria-label="Pay with card"], #card-tab').first();
    if ((await cardTab.count()) && (await cardTab.isVisible())) await cardTab.click();

    await page.locator('#cardNumber').waitFor({ state: 'visible' });
    await fillIfVisible(page, '#email', buyer.email);
    await card.use(async (c) => {
      await page.locator('#cardNumber').fill(c.number);
      await page.locator('#cardExpiry').fill(`${String(c.expirationMonth).padStart(2, '0')} / ${String(c.expirationYear % 100).padStart(2, '0')}`);
      await page.locator('#cardCvc').fill(c.cvc);
    });
    card.wipe();
    await fillIfVisible(page, '#billingName', buyer.name);
    const country = page.locator('#billingCountry');
    if (buyer.country && (await country.count()) && (await country.isVisible())) await country.selectOption(buyer.country).catch(() => undefined);
    if (buyer.postalCode) await fillIfVisible(page, '#billingPostalCode', buyer.postalCode);

    const startUrl = page.url();
    await page.locator('button[type="submit"], [data-testid="hosted-payment-submit-button"]').first().click();

    const outcome = await Promise.race([
      page.waitForURL((u) => !u.toString().startsWith(startUrl) && !u.hostname.endsWith('checkout.stripe.com'), { timeout }).then(() => 'redirect' as const),
      page.locator('text=/Thanks for your payment|Payment successful|お支払いが完了/i').first().waitFor({ timeout }).then(() => 'success_text' as const),
      page.locator('.FieldError, [role="alert"], .Notice--red, .ConfirmPaymentButton--error').first().waitFor({ timeout }).then(() => 'error' as const),
    ]).catch(() => 'timeout' as const);

    if (outcome === 'error' || outcome === 'timeout') {
      const texts = await page.locator('.FieldError, [role="alert"], .Notice').allInnerTexts().catch(() => []);
      // 入力欄の中身は読まない（カード番号を外に出さないため）
      return { ok: false, finalUrl: page.url(), message: redact(`${outcome}: ${texts.join(' | ').slice(0, 500)}`) };
    }
    return { ok: true, finalUrl: page.url(), message: outcome };
  } catch (e) {
    return { ok: false, finalUrl: '', message: redact(`exception: ${(e as Error).message}`.slice(0, 500)) };
  } finally {
    card.wipe();
    await browser?.close().catch(() => undefined);
  }
}
