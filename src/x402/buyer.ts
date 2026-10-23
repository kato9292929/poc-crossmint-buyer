import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import type { ClientEvmSigner } from '@x402/evm';
import { wrapFetchWithPayment } from '@x402/fetch';
import { SpendGuard } from '../caps.ts';
import { appendPurchase, baseEntry, readDay, type PurchaseLogEntry } from '../log.ts';
import { microToUsd, usdToMicro, type MicroUsd } from '../money.ts';
import { probe402, selectRequirements, type AllowedAsset } from './requirements.ts';

export interface BuyParams {
  url: string;
  /** 想定価格（USD）。402 の金額がこれと違えば署名しない */
  expectedUsd: string;
  /** null のときは、選べる accepts が無いことを確かめてログに残すだけ（Crossmint に触らない） */
  signer: ClientEvmSigner | null;
  walletNetwork: string;
  payer: string | null;
  guard: SpendGuard;
  assets: AllowedAsset[];
  env: string;
  target: string;
  outDir?: string;
  fetchImpl?: typeof fetch;
}

export interface BuyResult {
  entry: PurchaseLogEntry;
  status: number | null;
  bodyFile: string | null;
}

/** 当日のログから、署名して送った支払いの合計（日次上限の復元用）。 */
export function signedSpendForDay(day: string): MicroUsd {
  return readDay(day)
    .filter((e) => e.phase === 'A' && e.ref?.signed === true)
    .reduce((sum, e) => sum + usdToMicro(e.amount), 0n);
}

/**
 * x402 のエンドポイントを1回買う。
 * 1. 未払いで GET して 402 の accepts を読む
 * 2. 許可済みの資産・Crossmint で払えるネットワーク・想定価格・上限をすべて満たすときだけ署名する
 * 3. @x402/fetch の wrapFetchWithPayment で「402 → 署名 → 再送」を行う
 */
export async function buyOnce(p: BuyParams): Promise<BuyResult> {
  const f = p.fetchImpl ?? fetch;
  const started = new Date();
  const base = {
    ...baseEntry(started),
    phase: 'A' as const,
    buyer: 'crossmint-wallet' as const,
    seller: 'jin' as const,
    item: p.url,
    currency: 'USDC',
    payer: p.payer,
    env: p.env,
    target: p.target,
  };
  const fail = (error: string, extra: Partial<PurchaseLogEntry> = {}, ref: PurchaseLogEntry['ref'] = {}): BuyResult => {
    const entry: PurchaseLogEntry = {
      ...base,
      amount: p.expectedUsd,
      network: p.walletNetwork,
      tx: null,
      result: 'failure',
      error,
      ...extra,
      ref: { signed: false, ...ref },
    };
    appendPurchase(entry, started);
    return { entry, status: null, bodyFile: null };
  };

  let probe;
  try {
    probe = await probe402(p.url, f);
  } catch (e) {
    return fail(`probe_failed: ${(e as Error).message}`);
  }
  if (!probe.paymentRequired) return fail(`expected_402: status ${probe.status}`);

  const sel = selectRequirements(probe.paymentRequired, p.walletNetwork, p.assets);
  if (!sel.ok) {
    const first = probe.paymentRequired.accepts[0];
    return fail(`${sel.reason}: ${sel.detail}`, first ? { network: first.network, amount: p.expectedUsd } : {});
  }
  const req = sel.requirements;
  const amountUsd = microToUsd(sel.amountMicro);
  if (sel.amountMicro !== usdToMicro(p.expectedUsd)) {
    return fail(`price_mismatch: 402 は $${amountUsd}、想定は $${p.expectedUsd}`, { network: req.network, amount: amountUsd });
  }
  if (!p.signer) return fail('no_signer: Crossmint のウォレットが未設定（.env）', { network: req.network, amount: amountUsd });

  const reservation = p.guard.reserve(sel.amountMicro);
  if (!reservation.ok) return fail(`${reservation.reason}: ${reservation.detail}`, { network: req.network, amount: amountUsd });

  let signed = false;
  const client = new x402Client()
    .register(p.walletNetwork as `${string}:${string}`, new ExactEvmScheme(p.signer))
    // 選んだ要件と同じもの（ネットワーク・資産・受取先・金額）以外には署名しない
    .registerPolicy((_v, reqs) => reqs.filter((r) => sameRequirements(r, req)))
    .setSpendControls({ maxAmountPerPayment: `$${microToUsd(p.guard.maxPerCall)}` })
    .onBeforePaymentCreation(async ({ selectedRequirements }) => {
      if (!sameRequirements(selectedRequirements, req)) return { abort: true, reason: '事前に確認した 402 と要件が変わった' };
    })
    .onAfterPaymentCreation(async () => {
      signed = true;
    });

  let res: Response;
  try {
    res = await wrapFetchWithPayment(f, client)(p.url, { method: 'GET' });
  } catch (e) {
    signed ? reservation.commit() : reservation.release();
    return fail(`payment_failed: ${(e as Error).message}`, { network: req.network, amount: amountUsd }, { signed });
  }
  signed ? reservation.commit() : reservation.release();

  const text = await res.text();
  let tx: string | null = null;
  let settleError: string | null = null;
  try {
    const settle = new x402HTTPClient(client).getPaymentSettleResponse((n) => res.headers.get(n));
    tx = settle.transaction || null;
    if (!settle.success) settleError = settle.errorReason ?? 'settle_failed';
  } catch {
    // 200 でも PAYMENT-RESPONSE が無い場合がある。tx は null のまま
  }

  let bodyFile: string | null = null;
  if (res.ok) {
    const dir = p.outDir ?? 'out';
    mkdirSync(dir, { recursive: true });
    const name = new URL(p.url).pathname.split('/').filter(Boolean).join('_');
    bodyFile = join(dir, `${p.target}-${name}-${started.toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(bodyFile, text);
  }

  const ok = res.ok && !settleError;
  const entry: PurchaseLogEntry = {
    ...base,
    amount: amountUsd,
    network: req.network,
    tx,
    result: ok ? 'success' : 'failure',
    error: ok ? null : `http_${res.status}${settleError ? `: ${settleError}` : ''}: ${text.slice(0, 300)}`,
    ref: { signed, status: res.status, payTo: req.payTo, asset: req.asset, bodyFile },
  };
  appendPurchase(entry, started);
  return { entry, status: res.status, bodyFile };
}

function sameRequirements(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.asset.toLowerCase() === b.asset.toLowerCase() &&
    a.payTo.toLowerCase() === b.payTo.toLowerCase() &&
    a.amount === b.amount
  );
}
