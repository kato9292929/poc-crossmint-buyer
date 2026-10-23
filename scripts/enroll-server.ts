/**
 * フェーズB：本人が1回だけ開くローカルのページ（web/enroll）と、その裏側の API。
 *
 *   npm run enroll      → http://localhost:5174 を開く
 *
 * ページでやること（本人の操作）: Crossmint にサインイン → カードを登録（Crossmint のホスト型 iframe）
 *   → order intent（$1.00・Nevermined・2時間）を passkey で承認 → 「購入を実行」を押す
 * 裏側でやること（CC が用意したコード）: カードの登録（エージェント用の認証）・order intent の作成と状態確認・
 *   カード番号の取得・Stripe Checkout での支払い・Nevermined の残高確認・ログ出力
 *
 * 利用者の JWT はリクエストごとにブラウザから受け取り、保存もログ出力もしない。
 */
import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { HARD_MAX_CARD_USD, crossmintEnv, optional, required } from '../src/config.ts';
import { CrossmintApiError, OrderIntentsClient, railNeedingVerification, selectRail } from '../src/crossmint/order-intents.ts';
import { recordBlocker } from '../src/blockers.ts';
import { purchasePlanWithCard } from '../src/card-purchase.ts';
import { PLAN } from '../src/nevermined/plan.ts';

const port = Number(optional('ENROLL_PORT') ?? 5174);
const clientApiKey = required('CROSSMINT_CLIENT_API_KEY');
const env = crossmintEnv(clientApiKey);
const merchant = {
  name: optional('CARD_MERCHANT_NAME') ?? 'Nevermined',
  url: optional('CARD_MERCHANT_URL') ?? 'https://nevermined.app',
  countryCode: optional('CARD_MERCHANT_COUNTRY') ?? 'US',
};
if (Number(PLAN.priceUsd) > Number(HARD_MAX_CARD_USD)) throw new Error('プランの価格が上限を超えている');

const vite = await createViteServer({
  root: fileURLToPath(new URL('../web/enroll', import.meta.url)),
  plugins: [react()],
  server: { middlewareMode: true },
  appType: 'spa',
});

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function clientFor(req: IncomingMessage): OrderIntentsClient {
  const auth = req.headers.authorization ?? '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!jwt) throw Object.assign(new Error('JWT が無い（サインインしてから）'), { status: 401 });
  return new OrderIntentsClient(env, clientApiKey, jwt);
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return json(res, 200, { env, clientApiKey, plan: { name: PLAN.name, priceUsd: PLAN.priceUsd, credits: PLAN.credits }, merchant });
    }
    if (url.pathname === '/api/register-card' && req.method === 'POST') {
      const b = await readJson(req);
      const r = await clientFor(req).registerCard(String(b.paymentMethodId), {
        email: String(b.email),
        countryCode: String(b.countryCode ?? 'US'),
        languageCode: String(b.languageCode ?? 'en-US'),
      });
      return json(res, 200, r);
    }
    if (url.pathname === '/api/order-intents' && req.method === 'POST') {
      const b = await readJson(req);
      const oi = await clientFor(req).createOrderIntent({
        paymentMethodId: String(b.paymentMethodId),
        amount: { value: PLAN.priceUsd, currency: 'USD' },
        merchant,
        description: `poc-crossmint-buyer: Nevermined ${PLAN.name}（$${PLAN.priceUsd}）を1回購入`,
        expiresAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      });
      return json(res, 200, { orderIntent: oi, selectedRail: selectRail(oi.rails) ?? null, needsVerification: railNeedingVerification(oi.rails) ?? null });
    }
    const m = /^\/api\/order-intents\/([^/]+)$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const oi = await clientFor(req).getOrderIntent(decodeURIComponent(m[1]));
      return json(res, 200, { orderIntent: oi, selectedRail: selectRail(oi.rails) ?? null, needsVerification: railNeedingVerification(oi.rails) ?? null });
    }
    if (url.pathname === '/api/purchase' && req.method === 'POST') {
      const b = await readJson(req);
      const entry = await purchasePlanWithCard({
        client: clientFor(req),
        orderIntentId: String(b.orderIntentId),
        buyer: { email: String(b.email), name: optional('CARD_BUYER_NAME') ?? 'Crossmint Agent Buyer', postalCode: optional('CARD_BUYER_POSTAL_CODE') ?? '94105', country: optional('CARD_BUYER_COUNTRY') ?? 'US' },
        force: b.force === true,
        headless: optional('HEADFUL') !== 'true',
      });
      return json(res, 200, { entry });
    }
    json(res, 404, { error: 'not_found' });
  } catch (e) {
    if (e instanceof CrossmintApiError) {
      recordBlocker(`フェーズB: ${req.method} ${url.pathname}`, e.failure);
      return json(res, 502, { error: 'crossmint_api_error', status: e.failure.status, endpoint: e.failure.endpoint, body: e.failure.responseBody.slice(0, 2000) });
    }
    json(res, (e as { status?: number }).status ?? 500, { error: (e as Error).message });
  }
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return void api(req, res, url);
  vite.middlewares(req, res);
}).listen(port, () => {
  console.log(`web/enroll: http://localhost:${port}  （Crossmint ${env}）`);
});
