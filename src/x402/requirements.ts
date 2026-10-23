import { readFileSync } from 'node:fs';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { atomicToMicro, type MicroUsd } from '../money.ts';

export interface AllowedAsset {
  network: string;
  asset: string;
  symbol: string;
  decimals: number;
  testnet: boolean;
  /** Crossmint のエージェントウォレットで、このネットワークの x402 に署名できるか */
  payableByCrossmint: boolean;
}

export function loadAssets(path = new URL('../../config/assets.json', import.meta.url)): AllowedAsset[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { assets: AllowedAsset[] }).assets;
}

export function findAsset(assets: AllowedAsset[], network: string, asset: string): AllowedAsset | undefined {
  // EVM のアドレスは大文字小文字を区別しない。Solana の mint は区別する
  const eq = network.startsWith('eip155:') ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b;
  return assets.find((a) => a.network === network && eq(a.asset, asset));
}

/** 未払いの GET で 402 を受け取り、PAYMENT-REQUIRED（x402 v2）を読む。402 でなければ null。 */
export async function probe402(url: string, fetchImpl: typeof fetch = fetch): Promise<{ status: number; paymentRequired: PaymentRequired | null }> {
  const res = await fetchImpl(url, { method: 'GET' });
  await res.arrayBuffer().catch(() => undefined);
  if (res.status !== 402) return { status: res.status, paymentRequired: null };
  const header = res.headers.get('payment-required');
  if (!header) throw new Error(`${url}: 402 だが PAYMENT-REQUIRED ヘッダが無い（x402 v1 の本文形式は扱わない）`);
  return { status: 402, paymentRequired: decodePaymentRequiredHeader(header) };
}

export type Selection =
  | { ok: true; requirements: PaymentRequirements; asset: AllowedAsset; amountMicro: MicroUsd }
  | { ok: false; reason: 'no_allowed_asset' | 'not_payable_by_crossmint' | 'network_mismatch'; detail: string };

/**
 * 402 の accepts から、このウォレットが払えるものを1つ選ぶ。
 * - config/assets.json に無い資産は払わない
 * - Crossmint で署名できないネットワーク（Solana）は払わない（理由を返す）
 * - ウォレットのネットワーク（staging は eip155:84532、本番は eip155:8453）と一致するものだけ
 */
export function selectRequirements(pr: PaymentRequired, walletNetwork: string, assets: AllowedAsset[]): Selection {
  const exact = pr.accepts.filter((a) => a.scheme === 'exact');
  const known = exact.map((r) => ({ r, asset: findAsset(assets, r.network, r.asset) })).filter((x) => x.asset);
  if (known.length === 0) {
    return { ok: false, reason: 'no_allowed_asset', detail: `accepts に許可済みの資産が無い: ${describeAccepts(pr)}` };
  }
  const payable = known.filter((x) => x.asset!.payableByCrossmint);
  if (payable.length === 0) {
    return {
      ok: false,
      reason: 'not_payable_by_crossmint',
      detail:
        `売り手が受け付けるのは ${describeAccepts(pr)} だけ。Crossmint のウォレットはこのネットワークの x402 に署名できない` +
        '（Solana ウォレットは署名 API が無く、sendTransaction しか持たない。docs/blockers.md の A-1）',
    };
  }
  const match = payable.find((x) => x.r.network === walletNetwork);
  if (!match) {
    return { ok: false, reason: 'network_mismatch', detail: `ウォレットは ${walletNetwork}。accepts: ${describeAccepts(pr)}` };
  }
  return { ok: true, requirements: match.r, asset: match.asset!, amountMicro: atomicToMicro(match.r.amount, match.asset!.decimals) };
}

export function describeAccepts(pr: PaymentRequired): string {
  return pr.accepts.map((a) => `${a.scheme}/${a.network}/${a.asset}/${a.amount}→${a.payTo}`).join(', ');
}
