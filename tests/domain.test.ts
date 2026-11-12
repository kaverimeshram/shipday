import { describe, expect, it } from 'vitest';
import { canCancel, chargeRefusal, isChargeEligible, moveWave, planWaves } from '../src/domain.js';

describe('reservation wave planning', () => {
  it('allocates capacity in reservation order across dated waves', () => {
    const result = planWaves(
      [
        { id: 'w1', units: 2, milestone: 'arrived_warehouse', eventDate: '2026-11-01' },
        { id: 'w2', units: 3, milestone: 'arrived_warehouse', eventDate: '2026-11-05' },
      ],
      [{ id: 'r2', qty: 3, position: 2 }, { id: 'r1', qty: 2, position: 1 }],
    );
    expect(result.allocations).toEqual([
      { reservationId: 'r1', waveId: 'w1', qty: 2 },
      { reservationId: 'r2', waveId: 'w2', qty: 3 },
    ]);
    expect(result.waves.map(w => w.shipDate)).toEqual(['2026-11-03', '2026-11-07']);
  });

  it('rejects a zero reservation quantity instead of silently assigning it', () => {
    expect(() => planWaves([], [{ id: 'r', qty: 0, position: 1 }])).toThrow('positive integer');
  });
});

describe('charge window', () => {
  it('opens exactly the configured number of days before ship date', () => {
    expect(isChargeEligible('2026-11-20', new Date('2026-10-30T23:59:00Z'), 20)).toBe(false);
    expect(isChargeEligible('2026-11-20', new Date('2026-11-01T00:00:00Z'), 20)).toBe(true);
    expect(isChargeEligible('2026-11-20', new Date('2026-11-21T00:00:00Z'), 20)).toBe(false);
  });

  it('rejects negative windows', () => {
    expect(() => isChargeEligible('2026-11-20', new Date(), -1)).toThrow('non-negative');
  });
});

describe('charge idempotency and cancellation', () => {
  it('refuses an existing capture and allows a recorded decline to retry', () => {
    expect(chargeRefusal('RESERVED', false)).toBeNull();
    expect(chargeRefusal('DECLINED', false)).toBeNull();
    expect(chargeRefusal('CHARGED', true)).toContain('already been charged');
    expect(chargeRefusal('RESERVED', true)).toContain('already been charged');
  });

  it('allows cancellation only before charge begins', () => {
    expect(canCancel('PENDING')).toBe(true);
    expect(canCancel('RESERVED')).toBe(true);
    expect(canCancel('CHARGE_PENDING')).toBe(false);
    expect(canCancel('CHARGED')).toBe(false);
  });
});

describe('ship date replanning', () => {
  it('moves one wave and rejects an unknown wave or invalid date', () => {
    const waves = [{ id: 'w1', number: 1, units: 4, shipDate: '2026-11-20' }];
    expect(moveWave(waves, 'w1', '2026-11-29')[0]?.shipDate).toBe('2026-11-29');
    expect(() => moveWave(waves, 'missing', '2026-11-29')).toThrow('does not exist');
    expect(() => moveWave(waves, 'w1', 'later')).toThrow('Invalid ship date');
    expect(() => moveWave(waves, 'w1', '2026-02-31')).toThrow('Invalid ship date');
  });
});
