import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atomicToMicro, microToUsd, usdToMicro } from '../src/money.ts';
import { SpendGuard } from '../src/caps.ts';
import { jstDay } from '../src/log.ts';

test('金額の変換', () => {
  assert.equal(usdToMicro('0.01'), 10_000n);
  assert.equal(usdToMicro('1'), 1_000_000n);
  assert.equal(microToUsd(20_000n), '0.02');
  assert.equal(microToUsd(1_000_000n), '1.00');
  assert.equal(microToUsd(12_345n), '0.012345');
  assert.equal(atomicToMicro('10000', 6), 10_000n);
  assert.equal(atomicToMicro('10000000000000001', 18), 10_001n); // 端数は切り上げ
  assert.throws(() => usdToMicro('0.0000001'));
});

test('1回の上限を超える支払いは予約できない', () => {
  const g = new SpendGuard(usdToMicro('0.05'), usdToMicro('0.50'));
  const r = g.reserve(usdToMicro('0.06'));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'per_call_cap');
});

test('1日の上限：予約・確定・解放を数える', () => {
  const g = new SpendGuard(usdToMicro('0.05'), usdToMicro('0.10'));
  const a = g.reserve(usdToMicro('0.05'));
  const b = g.reserve(usdToMicro('0.05'));
  assert.ok(a.ok && b.ok);
  const c = g.reserve(usdToMicro('0.01'));
  assert.equal(!c.ok && c.reason, 'daily_cap');
  if (a.ok) a.release();
  if (b.ok) b.commit();
  assert.ok(g.reserve(usdToMicro('0.05')).ok);
});

test('日付は JST で切り替わり、当日のログから復元する', () => {
  let now = new Date('2026-10-23T14:59:00Z'); // JST 23:59
  const restored: string[] = [];
  const g = new SpendGuard(usdToMicro('0.05'), usdToMicro('0.05'), (d) => (restored.push(d), d === '2026-10-23' ? usdToMicro('0.05') : 0n), () => now);
  assert.equal(g.reserve(usdToMicro('0.01')).ok, false);
  now = new Date('2026-10-23T15:00:00Z'); // JST 翌 00:00
  assert.equal(jstDay(now), '2026-10-24');
  assert.ok(g.reserve(usdToMicro('0.01')).ok);
  assert.deepEqual(restored, ['2026-10-23', '2026-10-24']);
});
