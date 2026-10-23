import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { createPublicClient, getAddress, http, verifyTypedData, type Hex, type PublicClient } from 'viem';
import { baseSepolia } from 'viem/chains';
import { JIN_ENDPOINTS } from '../jin.ts';

/**
 * JIN の 402 を再現したローカルの x402 サーバー（staging 用）。
 *
 * - mode 'evm'（既定）: JIN と同じパス・説明・金額・タイムアウトで、ネットワークと資産だけを
 *   Base Sepolia の USDC に置き換える。Crossmint の staging ウォレット（base-sepolia）で「402 受信 → 署名 → 再送」を確かめる用。
 * - mode 'jin-solana': JIN の 402 をそのまま返す（Solana mainnet の USDC）。Crossmint では払えないことを手元で再現する用。
 *
 * 決済（settle）はしない。署名を検証し、要件と一致すれば 200 と PAYMENT-RESPONSE（transaction は local-mock-…）を返す。
 * 検証は viem の verifyTypedData（EOA・ERC-1271・ERC-6492 に対応）。verify: 'rpc' は Base Sepolia の RPC を使う
 * （Crossmint のスマートウォレットはコントラクト署名なので必要）。'offline' は EOA の署名だけを検証する（テスト用）。
 */
export interface LocalServerOptions {
  port?: number;
  mode?: 'evm' | 'jin-solana';
  verify?: 'rpc' | 'offline';
  rpcUrl?: string;
  /** 受取先（Base Sepolia の任意のアドレス。決済しないので資金は動かない） */
  payTo?: `0x${string}`;
}

/** フェーズ0で記録した JIN の 402（2026-10-23 取得。docs/phase0.md） */
export const JIN_SOLANA_ACCEPT = {
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: '4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf',
  maxTimeoutSeconds: 300,
  feePayer: 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww',
} as const;

const DESCRIPTIONS: Record<string, string> = {
  series: 'JIN daily food index series (excl/incl, matched SKU count). Single-store observation, not official CPI, not a forecast.',
  movers: 'JIN daily inflation nowcast movers: per-day mover SKUs vs base date, with promo tags. Single-store observation, not a forecast.',
};

const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const DEFAULT_PAY_TO = '0x000000000000000000000000000000000000dEaD';

const authorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export function requirementsFor(id: string, resourceUrl: string, o: LocalServerOptions): PaymentRequirements {
  const ep = JIN_ENDPOINTS.find((e) => e.id === id)!;
  const amount = String(Math.round(Number(ep.priceUsd) * 1_000_000));
  if (o.mode === 'jin-solana') {
    const { feePayer, ...rest } = JIN_SOLANA_ACCEPT;
    return { ...rest, amount, extra: { resource: resourceUrl, feePayer } };
  }
  return {
    scheme: 'exact',
    network: 'eip155:84532',
    asset: BASE_SEPOLIA_USDC,
    amount,
    payTo: o.payTo ?? DEFAULT_PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { resource: resourceUrl, name: 'USDC', version: '2' },
  };
}

export function startLocalX402Server(o: LocalServerOptions = {}): Promise<{ server: Server; url: string }> {
  const opts = { mode: 'evm' as const, verify: 'rpc' as const, ...o };
  const client = createPublicClient({ chain: baseSepolia, transport: http(opts.rpcUrl ?? 'https://sepolia.base.org') });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const ep = JIN_ENDPOINTS.find((e) => e.path === url.pathname);
    if (!ep || req.method !== 'GET') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
      return;
    }
    const resourceUrl = `${url.origin}${ep.path}`;
    const requirements = requirementsFor(ep.id, resourceUrl, opts);
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      error: 'Payment required',
      resource: { url: resourceUrl, description: DESCRIPTIONS[ep.id], mimeType: '' },
      accepts: [requirements],
    };
    const send402 = (error?: string) => {
      const body = error ? { ...paymentRequired, error } : paymentRequired;
      res.writeHead(402, {
        'content-type': 'application/json',
        'payment-required': encodePaymentRequiredHeader(body),
        'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE',
      });
      res.end('{}');
    };

    const header = req.headers['payment-signature'] ?? req.headers['x-payment'];
    if (!header || Array.isArray(header)) return send402();

    try {
      const payload = decodePaymentSignatureHeader(header);
      const reason = await verifyEvmPayment(payload as unknown as EvmPaymentPayload, requirements, opts.verify, client);
      if (reason) return send402(reason);
      const p = (payload as unknown as EvmPaymentPayload).payload;
      const settle = {
        success: true,
        transaction: `local-mock-${randomBytes(8).toString('hex')}`,
        network: requirements.network,
        payer: p.authorization.from,
      };
      res.writeHead(200, {
        'content-type': 'application/json',
        'payment-response': encodePaymentResponseHeader(settle as never),
      });
      res.end(JSON.stringify({ source: 'local-x402-test-server', endpoint: ep.id, note: 'JIN の 402 を再現したローカルサーバーの応答。実データではない', paid: settle }));
    } catch (e) {
      send402(`invalid_payload: ${(e as Error).message}`);
    }
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 4402, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}

interface EvmPaymentPayload {
  x402Version: number;
  accepted: PaymentRequirements;
  payload: {
    signature: Hex;
    authorization: { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex };
  };
}

/** 署名と要件の一致を確かめる。問題があれば理由（文字列）、なければ null。 */
export async function verifyEvmPayment(
  pp: EvmPaymentPayload,
  r: PaymentRequirements,
  mode: 'rpc' | 'offline',
  client: Pick<PublicClient, 'verifyTypedData'>,
): Promise<string | null> {
  if (!r.network.startsWith('eip155:')) return 'unsupported_network: このサーバーは EVM の支払いだけを検証する';
  if (pp.x402Version !== 2) return 'unsupported_version';
  const a = pp.payload?.authorization;
  if (!a || !pp.payload.signature) return 'missing_authorization';
  if (getAddress(a.to) !== getAddress(r.payTo)) return 'recipient_mismatch';
  if (a.value !== r.amount) return 'amount_mismatch';
  const now = Math.floor(Date.now() / 1000);
  if (BigInt(a.validBefore) <= BigInt(now) || BigInt(a.validAfter) > BigInt(now)) return 'authorization_expired';
  const chainId = Number(r.network.split(':')[1]);
  const typed = {
    domain: { name: String(r.extra.name), version: String(r.extra.version), chainId, verifyingContract: getAddress(r.asset) },
    types: authorizationTypes,
    primaryType: 'TransferWithAuthorization' as const,
    message: {
      from: getAddress(a.from),
      to: getAddress(a.to),
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    },
  };
  const valid =
    mode === 'rpc'
      ? await client.verifyTypedData({ address: getAddress(a.from), signature: pp.payload.signature, ...typed })
      : await verifyTypedData({ address: getAddress(a.from), signature: pp.payload.signature, ...typed });
  return valid ? null : 'invalid_signature';
}
