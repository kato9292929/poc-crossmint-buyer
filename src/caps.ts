import { jstDay } from './log.ts';
import { microToUsd, type MicroUsd } from './money.ts';

export type ReserveResult =
  | { ok: true; release(): void; commit(): void }
  | { ok: false; reason: 'per_call_cap' | 'daily_cap'; detail: string };

/**
 * 1回・1日の支払い上限。署名する「前」に reserve() し、超える支払いには署名しない。
 * 日の区切りは JST。起動時に当日のログから支払い済み額を復元する（restore）。
 */
export class SpendGuard {
  private day: string;
  private spent: MicroUsd;
  private reserved: MicroUsd = 0n;

  constructor(
    readonly maxPerCall: MicroUsd,
    readonly maxPerDay: MicroUsd,
    private readonly restore: (day: string) => MicroUsd = () => 0n,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.day = jstDay(this.now());
    this.spent = restore(this.day);
  }

  private rollover(): void {
    const today = jstDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.spent = this.restore(today);
      this.reserved = 0n;
    }
  }

  snapshot() {
    this.rollover();
    return { day: this.day, spent: this.spent, reserved: this.reserved };
  }

  reserve(amount: MicroUsd): ReserveResult {
    this.rollover();
    if (amount > this.maxPerCall) {
      return { ok: false, reason: 'per_call_cap', detail: `$${microToUsd(amount)} > 1回の上限 $${microToUsd(this.maxPerCall)}` };
    }
    const total = this.spent + this.reserved + amount;
    if (total > this.maxPerDay) {
      return {
        ok: false,
        reason: 'daily_cap',
        detail: `本日（JST ${this.day}）の支払い $${microToUsd(this.spent + this.reserved)} + $${microToUsd(amount)} > 1日の上限 $${microToUsd(this.maxPerDay)}`,
      };
    }
    this.reserved += amount;
    let done = false;
    return {
      ok: true,
      release: () => {
        if (done) return;
        done = true;
        this.reserved -= amount;
      },
      // 署名して送った支払いは、決済が確認できなくても計上したままにする（二重払いの側に倒さない）
      commit: () => {
        if (done) return;
        done = true;
        this.reserved -= amount;
        this.spent += amount;
      },
    };
  }
}
