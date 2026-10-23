import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { ApiFailure } from './crossmint/order-intents.ts';
import { jstTimestamp } from './log.ts';
import { redact } from './redact.ts';

/**
 * Crossmint の API がエラー・アクセス不可で止まったときの記録（回避策は探さない）。
 * docs/blockers.md の末尾（「自動記録」）に、エンドポイント・リクエスト・レスポンスをそのまま追記する。キーは伏せる。
 */
export function recordBlocker(step: string, f: ApiFailure, file = 'docs/blockers.md'): void {
  const body = [
    '',
    `### ${jstTimestamp()} ${step}`,
    '',
    `- エンドポイント: \`${f.method} ${f.endpoint}\``,
    `- HTTP ステータス: ${f.status}`,
    '- リクエスト本文:',
    '',
    '```json',
    redact(JSON.stringify(f.requestBody, null, 2)),
    '```',
    '',
    '- レスポンス本文:',
    '',
    '```',
    redact(f.responseBody).slice(0, 4000),
    '```',
    '',
  ].join('\n');
  appendFileSync(file, body);
  mkdirSync('out', { recursive: true });
  writeFileSync(`out/blocker-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify({ step, ...f }, null, 2));
}
