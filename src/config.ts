import 'dotenv/config';
import { usdToMicro, type MicroUsd } from './money.ts';

/**
 * 支払い上限（コードで固定する値）。環境変数 MAX_USD_PER_CALL / MAX_USD_PER_DAY では下げることしかできない。
 * 実証1と同じく「署名する前」に判定し、超える 402 には署名しない。
 */
export const HARD_MAX_PER_CALL: MicroUsd = usdToMicro('0.05');
export const HARD_MAX_PER_DAY: MicroUsd = usdToMicro('0.50');

/** フェーズB：order intent の上限。プリペイドプラン（prepaid-100）は $1 なので、それ以上は許さない。 */
export const HARD_MAX_CARD_USD = '1.00';

export function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`環境変数 ${name} が未設定（.env.example を参照）`);
  return v.trim();
}

export function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function lowerOnly(name: string, hard: MicroUsd): MicroUsd {
  const raw = optional(name);
  if (!raw) return hard;
  const v = usdToMicro(raw);
  if (v > hard) throw new Error(`${name}=${raw} はコードの上限を超えている（下げることしかできない）`);
  return v;
}

export function spendCaps(): { perCall: MicroUsd; perDay: MicroUsd } {
  return { perCall: lowerOnly('MAX_USD_PER_CALL', HARD_MAX_PER_CALL), perDay: lowerOnly('MAX_USD_PER_DAY', HARD_MAX_PER_DAY) };
}

export type CrossmintEnv = 'staging' | 'production';

/**
 * Crossmint の API キーの接頭辞（sk_staging_ / ck_staging_ / sk_production_ / ck_production_）から環境を判定する。
 * CROSSMINT_ENV があれば一致を確かめる（取り違えて本番で動かさないため）。
 */
export function crossmintEnv(apiKey: string): CrossmintEnv {
  const m = /^(?:sk|ck)_(staging|production)_/.exec(apiKey);
  if (!m) throw new Error('Crossmint の API キーの形式が想定外（sk_staging_ / sk_production_ で始まるはず）');
  const env = m[1] as CrossmintEnv;
  const declared = optional('CROSSMINT_ENV');
  if (declared && declared !== env) throw new Error(`CROSSMINT_ENV=${declared} だが API キーは ${env}`);
  if (env === 'production' && optional('ALLOW_PRODUCTION') !== 'true') {
    throw new Error('本番キーで動かすには ALLOW_PRODUCTION=true が必要（本番の実購入は series・movers 各1回だけ）');
  }
  return env;
}

export function crossmintBaseUrl(env: CrossmintEnv): string {
  return env === 'production' ? 'https://www.crossmint.com' : 'https://staging.crossmint.com';
}

/** ウォレットのチェーン。x402 の EVM 経路は Base（本番）／Base Sepolia（staging）。 */
export function evmChainFor(env: CrossmintEnv): { chain: 'base' | 'base-sepolia'; network: 'eip155:8453' | 'eip155:84532' } {
  return env === 'production' ? { chain: 'base', network: 'eip155:8453' } : { chain: 'base-sepolia', network: 'eip155:84532' };
}

export const JIN_BASE_URL = optional('JIN_BASE_URL') ?? 'https://jin.x402jp.com';
export const LOCAL_X402_URL = optional('LOCAL_X402_URL') ?? 'http://localhost:4402';
