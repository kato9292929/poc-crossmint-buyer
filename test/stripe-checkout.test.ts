import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CardCredential } from '../src/crossmint/order-intents.ts';
import { payStripeCheckout } from '../src/stripe-checkout.ts';

// Stripe Checkout と同じ id の入力欄を持つ偽のページ。Playwright の操作手順だけを確かめる（本物の Stripe ではない）
const page = (fail: boolean) => `<!doctype html><form id="f" action="/${fail ? 'fail' : 'success'}" method="get">
<input id="email"><input id="cardNumber" name="n"><input id="cardExpiry" name="e"><input id="cardCvc" name="c">
<input id="billingName" name="b"><select id="billingCountry"><option value="JP">JP</option><option value="US">US</option></select>
<input id="billingPostalCode"><button type="submit">Pay</button></form>
<script>document.getElementById('f').addEventListener('submit', (ev) => {
  const n = document.getElementById('cardNumber').value, e = document.getElementById('cardExpiry').value;
  if (${fail} || n !== '4000001000000000' || e !== '12 / 30') { ev.preventDefault(); document.body.insertAdjacentHTML('beforeend', '<div role="alert">Your card was declined. 4000001000000000</div>'); }
});</script>`;

function server() {
  let lastQuery = '';
  const s = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/success') {
      lastQuery = u.search;
      return void res.end('<p>Thanks for your payment</p>');
    }
    res.setHeader('content-type', 'text/html');
    res.end(page(u.pathname === '/declined'));
  });
  return new Promise<{ url: string; close: () => void; lastQuery: () => string }>((ok) =>
    s.listen(0, () => ok({ url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => s.close(), lastQuery: () => lastQuery })),
  );
}

const card = () => new CardCredential({ number: '4000001000000000', expirationMonth: 12, expirationYear: 2030, cvc: '123' }, { id: 'c', rail: 'agentic-token', amount: '1.00', expiresAt: '' });

test('Stripe Checkout 形式のページにカードを入れて支払い、カードは破棄する', async () => {
  const s = await server();
  try {
    const c = card();
    const r = await payStripeCheckout(`${s.url}/checkout`, c, { email: 'a@example.com', name: 'Agent', postalCode: '94105', country: 'US' });
    assert.equal(r.ok, true, r.message ?? '');
    assert.throws(() => c.use((v) => v.number));
  } finally {
    s.close();
  }
});

test('拒否されたときは、エラーの文言だけを返し、数字列は伏せる', async () => {
  const s = await server();
  try {
    const r = await payStripeCheckout(`${s.url}/declined`, card(), { email: 'a@example.com', name: 'Agent' }, { timeoutMs: 5000 });
    assert.equal(r.ok, false);
    assert.match(r.message ?? '', /declined/);
    assert.doesNotMatch(r.message ?? '', /4000001000000000/);
  } finally {
    s.close();
  }
});
