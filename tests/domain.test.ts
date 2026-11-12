import { describe, expect, it } from 'vitest';
import { canCancel, chargeRefusal, ganttDependencies, ganttTasks, isChargeEligible, matchShipments, moveWave, outsideChargeWindow, planWaves } from '../src/domain.js';
import { chargeWindow, localIsoDate } from '../web/src/dates.js';

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

  it('keeps a captured reservation in its original wave when later supply shifts dates', () => {
    const first = planWaves(
      [{ id: 'early', units: 2, milestone: 'departed', eventDate: '2026-11-01' }],
      [{ id: 'captured', qty: 2, position: 1 }],
    );
    const updated = planWaves(
      [
        { id: 'new-earlier', units: 2, milestone: 'departed', eventDate: '2026-10-20' },
        { id: 'early', units: 2, milestone: 'departed', eventDate: '2026-11-15' },
        { id: 'later', units: 2, milestone: 'departed', eventDate: '2026-12-01' },
      ],
      [{ id: 'captured', qty: 2, position: 1, status: 'CHARGED', captureId: 'capture-1', allocations: first.allocations }],
    );

    expect(updated.allocations.filter(a => a.reservationId === 'captured')).toEqual(first.allocations);
    expect(updated.waves.find(w => w.id === 'early')?.shipDate).not.toBe(first.waves[0]?.shipDate);
  });

  it('does not allocate pinned units from current supply a second time', () => {
    const updated = planWaves(
      [{ id: 'wave', units: 2, milestone: 'departed', eventDate: '2026-11-15' }],
      [
        { id: 'captured', qty: 2, position: 1, status: 'CHARGE_PENDING', allocations: [{ reservationId: 'captured', waveId: 'wave', qty: 2 }] },
        { id: 'next', qty: 2, position: 2 },
      ],
    );

    expect(updated.allocations.find(a => a.reservationId === 'next')).toEqual({ reservationId: 'next', waveId: 'wave', qty: 2 });
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

describe('charged wave slips past its window', () => {
  it('flags a capture once the ship date moves beyond capture day plus the window', () => {
    expect(outsideChargeWindow('2026-11-12T22:30:00.000Z', '2026-12-02', 20)).toBe(false);
    expect(outsideChargeWindow('2026-11-12T22:30:00.000Z', '2026-12-03', 20)).toBe(true);
    expect(outsideChargeWindow('2026-11-12T01:00:00.000Z', '2026-11-12', 0)).toBe(false);
    expect(outsideChargeWindow('2026-11-12T01:00:00.000Z', '2026-11-13', 0)).toBe(true);
  });
});

describe('shipment matching', () => {
  const rows = [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', position: 1, email: 'first@example.com' },
    { id: 'bbbbbbbb-0000-4000-8000-000000000002', position: 2, email: 'second@example.com' },
  ];
  it('matches by buyer email, reservation number, or reservation id and never assigns one reservation twice', () => {
    const result = matchShipments([
      { reference: null, recipient_email: 'SECOND@example.com', carrier: 'UPS', tracking_number: 'T2', quote: 'q2' },
      { reference: 'Order #1', recipient_email: null, carrier: 'USPS', tracking_number: 'T1', quote: 'q1' },
      { reference: 'bbbbbbbb', recipient_email: null, carrier: 'UPS', tracking_number: 'T3', quote: 'q3' },
    ], rows);
    expect(result.matched).toEqual([
      { reservationId: rows[1]!.id, trackingNumber: 'T2', carrier: 'UPS', quote: 'q2' },
      { reservationId: rows[0]!.id, trackingNumber: 'T1', carrier: 'USPS', quote: 'q1' },
    ]);
    expect(result.unmatched.map(s => s.tracking_number)).toEqual(['T3']);
  });
  it('does not read #12 as reservation 1', () => {
    expect(matchShipments([{ reference: 'Order #12', recipient_email: null, carrier: 'UPS', tracking_number: 'T', quote: 'q' }], rows).matched).toEqual([]);
  });
  it('leaves a shipment without a supported carrier unmatched', () => {
    expect(matchShipments([{ reference: '#1', recipient_email: null, carrier: null, tracking_number: 'T', quote: 'q' }], rows).matched).toEqual([]);
  });
});

describe('charge idempotency and cancellation', () => {
  it('refuses an existing capture and allows a recorded decline to retry', () => {
    expect(chargeRefusal('RESERVED', false)).toBeNull();
    expect(chargeRefusal('DECLINED', false)).toBeNull();
    expect(chargeRefusal('CHARGED', true)).toContain('already been charged');
    expect(chargeRefusal('RESERVED', true)).toContain('already been charged');
  });

  it('refuses to charge a reservation while a charge attempt is in flight', () => {
    expect(chargeRefusal('CHARGE_PENDING', false)).toContain('already in progress');
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

describe('gantt timeline', () => {
  const waves = [{ id: 'w1', number: 1, units: 480, shipDate: '2026-12-03' }];

  it('pins every phase to the planner dates so the chart engine cannot move them', () => {
    const children = ganttTasks(waves, 30)[0]!.children;
    expect(children.every(task => task.manuallyScheduled)).toBe(true);
    expect(children.find(task => task.id === 'w1-ship')?.startDate).toBe('2026-12-03');
  });

  it('only draws finish-to-start links that the planner dates already satisfy', () => {
    const tasks = new Map(ganttTasks(waves, 30)[0]!.children.map(task => [task.id, task]));
    for (const { fromTask, toTask } of ganttDependencies(waves)) {
      expect(tasks.get(fromTask)!.endDate <= tasks.get(toTask)!.startDate, `${fromTask} -> ${toTask}`).toBe(true);
    }
  });

  it('formats a dropped date from local calendar fields, not UTC', () => {
    const zone = process.env.TZ;
    process.env.TZ = 'Asia/Kolkata';
    try { expect(localIsoDate(new Date(2026, 11, 3))).toBe('2026-12-03'); }
    finally { process.env.TZ = zone; }
  });
});

describe('merchant charge window state', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  it('marks a window as closed once ship day has passed', () => {
    expect(chargeWindow('2026-11-10', 30, now)).toEqual({ eligible: false, opens: '2026-10-11', closed: true });
  });
  it('marks a future window as not yet open', () => {
    expect(chargeWindow('2027-01-12', 30, now)).toEqual({ eligible: false, opens: '2026-12-13', closed: false });
    expect(chargeWindow('2026-12-03', 30, now).eligible).toBe(true);
  });
});

describe('supply confirm idempotency', () => {
  const update = { units: 480, milestone: 'departed', date: '2026-11-12', origin: 'Yantian', destination: 'Long Beach', vesselOrCarrier: 'MSC ARIANE' };
  it('treats the same milestone confirmed twice as one update', async () => {
    const { sameSupply } = await import('../src/domain.js');
    expect(sameSupply(update, { ...update })).toBe(true);
    expect(sameSupply(update, { ...update, origin: ' yantian ', vesselOrCarrier: 'msc  ariane' })).toBe(true);
  });
  it('keeps genuinely different milestones apart', async () => {
    const { sameSupply } = await import('../src/domain.js');
    expect(sameSupply(update, { ...update, date: '2026-11-19' })).toBe(false);
    expect(sameSupply(update, { ...update, units: 240 })).toBe(false);
    expect(sameSupply(update, { ...update, milestone: 'arrived_port' })).toBe(false);
  });
});
