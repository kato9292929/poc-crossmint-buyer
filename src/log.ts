import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** JST（UTC+9、夏時間なし）の日付 YYYY-MM-DD。ログのファイル分割と1日の上限はこの日付にそろえる（実証1・実証2と同じ）。 */
export function jstDay(d = new Date()): string {
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** JST の時刻（ISO 8601、+09:00 付き）。 */
export function jstTimestamp(d = new Date()): string {
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().replace('Z', '+09:00');
}

/**
 * 購入ログの1行（1購入1行）。値が無い項目も省略せず null を入れる。
 * カード番号・CVC・API キー・JWT は入れない（入れられる項目を作らない）。
 */
export interface PurchaseLogEntry {
  /** JST の時刻（ISO 8601、+09:00） */
  time_jst: string;
  /** UTC の時刻（照合用） */
  time_utc: string;
  phase: 'A' | 'B';
  buyer: 'crossmint-wallet' | 'crossmint-card';
  seller: 'jin' | 'nevermined';
  /** フェーズA: エンドポイントの URL。フェーズB: プラン名 */
  item: string;
  /** 金額（USD、10進文字列） */
  amount: string;
  /** 通貨・資産（USDC / USD など） */
  currency: string;
  /** CAIP-2 のネットワーク。カードは 'card' */
  network: string;
  /** フェーズA: 支払い元アドレス。フェーズB: order intent ID */
  payer: string | null;
  /** トランザクションハッシュ／署名（フェーズA）、Stripe Checkout のセッション ID（フェーズB）。無ければ null */
  tx: string | null;
  result: 'success' | 'failure';
  error: string | null;
  /** 実行環境（staging / production）と相手先（jin / local など） */
  env: string;
  target: string;
  /** そのほかの参照（レスポンス本文の保存先など） */
  ref?: Record<string, string | number | boolean | null>;
}

export function logDir(): string {
  return process.env.LOG_DIR ?? 'logs';
}

/** ファイルに出すのは NODE_ENV=development のときだけ（実証1と同じ扱い）。それ以外は標準出力にだけ出す。 */
export function fileLoggingEnabled(): boolean {
  return process.env.NODE_ENV === 'development';
}

export function appendPurchase(entry: PurchaseLogEntry, now = new Date()): string | null {
  const line = JSON.stringify(entry);
  console.log(`[purchase-log] ${line}`);
  if (!fileLoggingEnabled()) return null;
  mkdirSync(logDir(), { recursive: true });
  const file = join(logDir(), `${jstDay(now)}.jsonl`);
  appendFileSync(file, line + '\n');
  return file;
}

export function readDay(day: string): PurchaseLogEntry[] {
  const file = join(logDir(), `${day}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PurchaseLogEntry);
}

export function baseEntry(now = new Date()): Pick<PurchaseLogEntry, 'time_jst' | 'time_utc'> {
  return { time_jst: jstTimestamp(now), time_utc: now.toISOString() };
}
