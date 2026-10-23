/** 金額はマイクロUSD（1 USD = 1_000_000n）の bigint で持つ。USDC の最小単位（小数6桁）と同じ。 */
export type MicroUsd = bigint;

export function usdToMicro(usd: string): MicroUsd {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usd.trim());
  if (!m) throw new Error(`金額の形式が不正: ${usd}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

export function microToUsd(micro: MicroUsd): string {
  const neg = micro < 0n;
  const v = neg ? -micro : micro;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${neg ? '-' : ''}${v / 1_000_000n}.${frac}`;
}

/** 資産の最小単位の額をマイクロUSDに直す（USD に連動したステーブルコインだけを扱う）。 */
export function atomicToMicro(amount: string, decimals: number): MicroUsd {
  if (!/^\d+$/.test(amount)) throw new Error(`amount が整数でない: ${amount}`);
  const a = BigInt(amount);
  if (decimals === 6) return a;
  if (decimals > 6) {
    const div = 10n ** BigInt(decimals - 6);
    // 端数は切り上げて、上限の判定を甘くしない
    return (a + div - 1n) / div;
  }
  return a * 10n ** BigInt(6 - decimals);
}
