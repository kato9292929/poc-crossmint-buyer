/**
 * フェーズB を、このクラウドセッションの中だけで通す（人の操作なし）。
 *
 *   npm run card:flow
 *
 * 1. web/enroll（scripts/enroll-server.ts）を CROSSMINT_AUTH=custom-jwt で起動する。カード利用者の JWT はサーバーが発行する
 * 2. Playwright（Chromium、WebAuthn の仮想認証器つき）でページを開き、staging のテストカード 4000 0566 5566 5556 を
 *    Crossmint の入力欄に入れて登録する
 * 3. order intent を作り、承認の画面（staging は Basis Theory の模擬画面）を通す
 * 4. 「購入を実行」を押す。裏側でカード番号を取得して Stripe Checkout で払い、Nevermined の残高を確かめる
 *
 * 各段階の画面は out/card-flow/<日時>/ に保存する（登録ページの画面だけ。取得したカード番号は別のブラウザで Stripe に入れるので、ここには写らない）。
 * 前提: CROSSMINT_CLIENT_API_KEY（ck_staging_）、NVM_API_KEY_BUYER（sandbox:）、Crossmint コンソールで Custom tokens に web/public/jwks.json の URL を登録済み。
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, type Frame, type Page } from 'playwright-core';
import { crossmintEnv, optional, required } from '../src/config.ts';
import { JWKS_URL, writeJwks } from '../src/crossmint/custom-jwt.ts';
import { buyerIdentity } from '../src/nevermined/plan.ts';

const TEST_CARD = { number: '4000056655665556', expiry: '12/30', cvc: '123', name: 'Agent Buyer', zip: '94105' };
const port = Number(optional('ENROLL_PORT') ?? 5174);
const base = `http://localhost:${port}`;

if (crossmintEnv(required('CROSSMINT_CLIENT_API_KEY')) !== 'staging') throw new Error('カード経路の自動実行は staging だけ');
required('NVM_API_KEY_BUYER');
if (await writeJwks()) {
  throw new Error(`署名鍵が新しくなった。web/public/jwks.json をコミット・プッシュしてから再実行する（Crossmint は ${JWKS_URL} を読む）`);
}

const outDir = `out/card-flow/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(outDir, { recursive: true });
let shot = 0;
const snap = async (page: Page, name: string) => {
  await page.screenshot({ path: `${outDir}/${String(++shot).padStart(2, '0')}-${name}.png`, fullPage: true }).catch(() => undefined);
};
const step = (msg: string) => console.log(`[card-flow] ${new Date().toISOString()} ${msg}`);

// 1. 登録ページの起動
const server = spawn('npx', ['tsx', 'scripts/enroll-server.ts'], {
  env: { ...process.env, CROSSMINT_AUTH: 'custom-jwt', NODE_ENV: 'development', ENROLL_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[enroll] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[enroll] ${d}`));
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);
for (let i = 0; ; i++) {
  if (await fetch(`${base}/api/config`).then((r) => r.ok).catch(() => false)) break;
  if (i > 60) throw new Error('登録ページが起動しない');
  await sleep(1000);
}
step('登録ページを起動した');

const browser = await chromium.launch({
  headless: optional('HEADFUL') !== 'true',
  executablePath: optional('CHROMIUM_PATH') ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({ locale: 'en-US' });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
page.on('console', (m) => m.type() === 'error' && console.log(`[page:error] ${m.text().slice(0, 300)}`));
// 模擬の Visa の画面が passkey を作る場合に備えて、WebAuthn の仮想認証器を付ける
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

/** すべてのフレームから、最初に見えた要素を探す。 */
async function findIn(selectors: string[], timeoutMs = 30_000): Promise<{ frame: Frame; selector: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      for (const sel of selectors) {
        const el = frame.locator(sel).first();
        if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) return { frame, selector: sel };
      }
    }
    await sleep(500);
  }
  return null;
}
async function fillAny(label: string, selectors: string[], value: string) {
  const hit = await findIn(selectors);
  if (!hit) throw new Error(`${label} の入力欄が見つからない`);
  await hit.frame.locator(hit.selector).first().click();
  await hit.frame.locator(hit.selector).first().pressSequentially(value, { delay: 30 });
}
async function clickAny(label: string, selectors: string[], timeoutMs = 30_000) {
  const hit = await findIn(selectors, timeoutMs);
  if (!hit) throw new Error(`${label} のボタンが見つからない`);
  await hit.frame.locator(hit.selector).first().click();
}
async function dumpFrames(tag: string) {
  for (const f of page.frames()) {
    const text = (await f.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    if (text) console.log(`[frame:${tag}] ${f.url().slice(0, 80)} :: ${text}`);
  }
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByText('2. カードを登録').waitFor({ timeout: 60_000 });
  await snap(page, 'signed-in');
  step('独自 JWT でサインイン済み');

  // 2. カード登録（Crossmint の iframe の中）
  await fillAny('カード番号', ['input[autocomplete="cc-number"]', 'input[name*="number" i]', 'input[placeholder*="1234"]', 'input[aria-label*="card number" i]'], TEST_CARD.number);
  await fillAny('有効期限', ['input[autocomplete="cc-exp"]', 'input[name*="exp" i]', 'input[placeholder*="MM" i]'], TEST_CARD.expiry);
  await fillAny('CVC', ['input[autocomplete="cc-csc"]', 'input[name*="cvc" i]', 'input[name*="cvv" i]', 'input[placeholder*="CVC" i]'], TEST_CARD.cvc);
  for (const [sels, v] of [
    [['input[autocomplete="cc-name"]', 'input[name*="name" i]'], TEST_CARD.name],
    [['input[autocomplete="postal-code"]', 'input[name*="zip" i]', 'input[name*="postal" i]'], TEST_CARD.zip],
  ] as const) {
    const hit = await findIn([...sels], 2000);
    if (hit && !(await hit.frame.locator(hit.selector).first().inputValue().catch(() => ''))) await hit.frame.locator(hit.selector).first().fill(v);
  }
  await snap(page, 'card-filled');
  await clickAny('カードの保存', ['button:has-text("Save")', 'button:has-text("Add")', 'button:has-text("Continue")', 'button[type="submit"]']);
  await page.getByText('登録済み:').waitFor({ timeout: 60_000 });
  await snap(page, 'card-saved');
  step('カードを登録した');

  // 3. order intent の作成と承認
  await page.getByRole('button', { name: 'order intent を作成して承認へ進む' }).click();
  const deadline = Date.now() + 5 * 60_000;
  let otpTried = 0;
  while (Date.now() < deadline) {
    if (await page.getByRole('heading', { name: '4. 購入を実行' }).isVisible().catch(() => false)) break;
    const err = await page.locator('pre.err').innerText().catch(() => '');
    if (err) throw new Error(`承認で止まった: ${err.slice(0, 1000)}`);
    // 模擬の承認画面: 連絡先の選択 → 続行 → ワンタイムコード（どの値でも通る）→ passkey
    const otp = await findIn(['input[autocomplete="one-time-code"]', 'input[inputmode="numeric"]', 'input[name*="otp" i]', 'input[name*="code" i]'], 1000);
    if (otp && otpTried < 3) {
      otpTried++;
      await otp.frame.locator(otp.selector).first().fill('123456');
      await snap(page, `otp-${otpTried}`);
    }
    const choice = await findIn(['[role="radio"]:not([aria-checked="true"])', 'input[type="radio"]:not(:checked)'], 500);
    if (choice) await choice.frame.locator(choice.selector).first().click().catch(() => undefined);
    const next = await findIn(
      ['button:has-text("Continue")', 'button:has-text("Verify")', 'button:has-text("Confirm")', 'button:has-text("Approve")', 'button:has-text("Submit")', 'button:has-text("Next")', 'button:has-text("Create passkey")', 'button:has-text("Use passkey")', 'button:has-text("Done")'],
      1000,
    );
    if (next) {
      await snap(page, 'verify');
      await next.frame.locator(next.selector).first().click().catch(() => undefined);
    }
    await sleep(1500);
  }
  if (!(await page.getByRole('heading', { name: '4. 購入を実行' }).isVisible())) {
    await dumpFrames('verify-timeout');
    throw new Error('5分以内に order intent の承認が終わらなかった');
  }
  await snap(page, 'order-intent-active');
  step('order intent を承認した');

  // 4. 購入
  await page.getByRole('button', { name: '購入を実行' }).click();
  const result = page.locator('section:has(h2:has-text("4. 購入を実行")) pre');
  await result.waitFor({ timeout: 7 * 60_000 }).catch(() => undefined);
  await snap(page, 'result');
  const text = (await result.innerText().catch(() => '')) || (await page.locator('pre.err').innerText().catch(() => '（結果が出なかった）'));
  console.log('\n=== 購入の結果 ===\n' + text);
  console.log('\n=== Nevermined の買い手 ===\n' + JSON.stringify(buyerIdentity()));
} catch (e) {
  await snap(page, 'error');
  await dumpFrames('error');
  console.error(`[card-flow] 失敗: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  stop();
}
