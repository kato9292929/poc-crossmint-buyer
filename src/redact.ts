/** blockers.md・標準出力に出す前に、API キー・JWT・シークレットらしい値を伏せる。 */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|ck)_(staging|production)_[A-Za-z0-9]+/g, '$1_$2_***')
    .replace(/xmsk1_[0-9a-fA-F]{64}/g, 'xmsk1_***')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '<jwt>')
    .replace(/\b(sandbox|live):[A-Za-z0-9._-]{20,}/g, '$1:***')
    .replace(/\b\d{13,19}\b/g, '<number>');
}

export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = /api-key|authorization|cookie/i.test(k) ? '***' : redact(v);
  return out;
}
