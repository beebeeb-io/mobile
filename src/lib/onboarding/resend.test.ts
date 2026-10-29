// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { GUESS_BUDGET, formatCountdown, resendRemainingSeconds } from './resend';

describe('resend countdown (task 1738 ruling: a resend sends a fresh code)', () => {
  test('nothing sent yet means nothing to wait for', () => {
    expect(resendRemainingSeconds(null, 60, 1_000_000)).toBe(0);
  });
  test('counts down from the DOCUMENT\'s resend_after_seconds, rounding up', () => {
    const sent = 1_000_000;
    expect(resendRemainingSeconds(sent, 60, sent)).toBe(60);
    expect(resendRemainingSeconds(sent, 60, sent + 17_400)).toBe(43);
    expect(resendRemainingSeconds(sent, 60, sent + 59_999)).toBe(1);
    expect(resendRemainingSeconds(sent, 60, sent + 60_000)).toBe(0);
    expect(resendRemainingSeconds(sent, 60, sent + 600_000)).toBe(0);
    // A different number from the server changes the wait (no constant baked in).
    expect(resendRemainingSeconds(sent, 900, sent)).toBe(900);
  });
  test('formats m:ss', () => {
    expect(formatCountdown(42)).toBe('0:42');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(900)).toBe('15:00');
    expect(formatCountdown(-3)).toBe('0:00');
  });
  test('the shared guess budget is five', () => {
    expect(GUESS_BUDGET).toBe(5);
  });
});
