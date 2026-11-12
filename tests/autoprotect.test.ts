import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipday-autoprotect-'));
const { db } = await import('../src/db.js');
const { GRACE_MS, holdDragRefunds, undoDragHold, activeHolds, autoProtectCampaign, campaignLedger, refundRequestId, settleRefund, slippedCharges, refundInputFor, MAX_AUTO_ATTEMPTS, AUTO_PROTECT_REASON } = await import('../src/autoprotect.js');
const { PayPalError } = await import('../src/paypal.js');

const fast = { pollDelayMs: () => 0 };
let n = 0;

// A campaign with one wave and one reservation charged on 2026-11-12 for a 2026-12-01 ship date (19 days, inside 20).
function seed(opts: { shipDate?: string; autoProtect?: number; qty?: number } = {}) {
  const id = `c${++n}`;
  db.prepare(`INSERT INTO campaigns (id, slug, name, price_cents, currency, quantity, ship_date, charge_window_days, merchant_key_hash, created_at, auto_protect)
    VALUES (?, ?, 'Tidewater', 4800, 'USD', 10, '2026-12-01', 20, 'x', '2026-11-01', ?)`).run(id, id, opts.autoProtect ?? 1);
  db.prepare(`INSERT INTO waves (id, campaign_id, number, units, ship_date) VALUES (?, ?, 1, 5, ?)`).run(`${id}-w`, id, opts.shipDate ?? '2026-12-01');
  db.prepare(`INSERT INTO reservations (id, campaign_id, email, qty, position, wave_id, status, capture_id, paypal_order_id, created_at)
    VALUES (?, ?, 'buyer@example.com', ?, 1, ?, 'CHARGED', ?, ?, '2026-11-02')`).run(`${id}-r`, id, opts.qty ?? 1, `${id}-w`, `CAP${id}`, `ORD${id}`);
  db.prepare(`INSERT INTO charge_attempts (id, reservation_id, paypal_request_id, capture_request_id, paypal_order_id, capture_id, status, created_at, completed_at, ship_date_at_charge)
    VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED', '2026-11-12T10:00:00.000Z', '2026-11-12T10:00:00.000Z', '2026-12-01')`).run(`${id}-a`, `${id}-r`, `p${id}`, `q${id}`, `ORD${id}`, `CAP${id}`);
  return id;
}
const slip = (id: string, date = '2027-01-15') => db.prepare('UPDATE waves SET ship_date = ? WHERE campaign_id = ?').run(date, id);
const reservation = (id: string) => db.prepare('SELECT status, capture_id FROM reservations WHERE id = ?').get(`${id}-r`) as { status: string; capture_id: string | null };
const refund = (id: string) => db.prepare('SELECT * FROM refunds WHERE reservation_id = ?').get(`${id}-r`) as any;

// Like PayPal, the mock returns the same refund for the same PayPal-Request-Id.
const refundIdFor = (requestId: string) => `REF-${requestId}`;
function client(behaviour: { create?: () => Promise<{ id: string; status: string }>; read?: (id: string) => Promise<{ id: string; status: string }> } = {}) {
  return {
    refundCapture: vi.fn(async (_capture: string, requestId: string) => behaviour.create ? behaviour.create() : { id: refundIdFor(requestId), status: 'PENDING' }),
    getRefund: vi.fn(async (id: string) => behaviour.read ? behaviour.read(id) : { id, status: 'COMPLETED' }),
  };
}

describe('auto-protect', () => {
  it('refunds a charge automatically once its wave slips past the charge window', async () => {
    const id = seed(); slip(id);
    const paypal = client();
    const results = await autoProtectCampaign(paypal, id, fast);
    const ref = refundIdFor(refundRequestId(`CAP${id}`, 1));
    expect(results).toMatchObject([{ id: `${id}-r`, status: 'REFUNDED', refundId: ref }]);
    expect(paypal.refundCapture).toHaveBeenCalledWith(`CAP${id}`, refundRequestId(`CAP${id}`, 1));
    expect(reservation(id)).toEqual({ status: 'RESERVED', capture_id: null });
    expect(refund(id)).toMatchObject({ status: 'COMPLETED', source: 'auto', refund_id: ref, amount_cents: 4800, old_ship_date: '2026-12-01', new_ship_date: '2027-01-15' });
    expect(refund(id).reason.startsWith(AUTO_PROTECT_REASON)).toBe(true);
  });

  it('leaves charges that still ship inside the window alone', async () => {
    const id = seed(); slip(id, '2026-12-02'); // 20 days after the charge: still inside
    const paypal = client();
    expect(await autoProtectCampaign(paypal, id, fast)).toEqual([]);
    expect(paypal.refundCapture).not.toHaveBeenCalled();
    expect(reservation(id).status).toBe('CHARGED');
    expect(refund(id)).toBeUndefined();
  });

  it('never refunds twice across repeated and concurrent replans', async () => {
    const id = seed(); slip(id);
    const paypal = client();
    await Promise.all([autoProtectCampaign(paypal, id, fast), autoProtectCampaign(paypal, id, fast), autoProtectCampaign(paypal, id, fast)]);
    slip(id, '2027-02-01');
    await autoProtectCampaign(paypal, id, fast);
    await autoProtectCampaign(paypal, id, fast);
    expect(paypal.refundCapture).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM refunds WHERE reservation_id = ?').get(`${id}-r`)).toEqual({ n: 1 });
  });

  it('does not let two direct settle calls both reach PayPal', async () => {
    const id = seed(); slip(id);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const paypal = client({ create: async () => { await gate; return { id: `REFX-${id}`, status: 'PENDING' }; } });
    const { campaign, rows } = slippedCharges(id);
    const input = refundInputFor(campaign!, rows[0]!, 'auto');
    const first = settleRefund(paypal, input, fast);
    const second = await settleRefund(paypal, input, fast);
    expect(second.status).toBe('REFUND_PENDING');
    release();
    expect((await first).status).toBe('REFUNDED');
    expect(paypal.refundCapture).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed PayPal refund retryable and not marked refunded, then retries it with a new attempt id', async () => {
    const id = seed(); slip(id);
    let clock = new Date('2026-11-20T10:00:00.000Z');
    const now = () => clock;
    const failing = client({ create: async () => { throw new PayPalError('Refund refused', 422, 'TRANSACTION_REFUSED'); } });
    expect(await autoProtectCampaign(failing, id, { ...fast, now })).toMatchObject([{ status: 'REFUND_FAILED', issue: 'TRANSACTION_REFUSED' }]);
    expect(reservation(id).status).toBe('CHARGED');
    expect(refund(id)).toMatchObject({ status: 'FAILED', attempts: 1, completed_at: null });
    // Within the backoff nothing is sent again.
    expect(await autoProtectCampaign(failing, id, { ...fast, now })).toEqual([]);
    expect(failing.refundCapture).toHaveBeenCalledTimes(1);
    // After the backoff the sweep retries under a fresh PayPal-Request-Id.
    clock = new Date(clock.getTime() + 10 * 60_000);
    const healthy = client();
    expect(await autoProtectCampaign(healthy, id, { ...fast, now })).toMatchObject([{ status: 'REFUNDED', attempt: 2 }]);
    expect(healthy.refundCapture).toHaveBeenCalledWith(`CAP${id}`, refundRequestId(`CAP${id}`, 2));
    expect(reservation(id).status).toBe('RESERVED');
    expect(campaignLedger(id).map(e => e.kind)).toEqual(expect.arrayContaining(['AUTO_REFUND', 'AUTO_REFUND_FAILED']));
  });

  it('retries a timed-out PayPal call with the same request id so PayPal replays it', async () => {
    const id = seed(); slip(id);
    const flaky = client({ create: async () => { throw new Error('socket hang up'); } });
    expect(await autoProtectCampaign(flaky, id, fast)).toMatchObject([{ status: 'REFUND_PENDING' }]);
    expect(refund(id)).toMatchObject({ status: 'PENDING', locked_until: null });
    const healthy = client();
    await autoProtectCampaign(healthy, id, fast);
    expect(flaky.refundCapture.mock.calls[0]![1]).toBe(healthy.refundCapture.mock.calls[0]![1]);
    expect(reservation(id).status).toBe('RESERVED');
  });

  it('checks the earlier refund before trying again and completes it instead of refunding twice', async () => {
    const id = seed(); slip(id);
    const now = () => new Date('2026-11-20T10:00:00.000Z');
    const slow = client({ read: async refundId => ({ id: refundId, status: 'FAILED' }) });
    await autoProtectCampaign(slow, id, { ...fast, now });
    expect(refund(id).status).toBe('FAILED');
    const later = () => new Date('2026-11-20T12:00:00.000Z');
    const recovered = client(); // the same refund now reads back COMPLETED
    expect(await autoProtectCampaign(recovered, id, { ...fast, now: later })).toMatchObject([{ status: 'REFUNDED', refundId: refundIdFor(refundRequestId(`CAP${id}`, 1)) }]);
    expect(recovered.refundCapture).not.toHaveBeenCalled();
  });

  it('stops retrying automatically after the attempt cap and when PayPal says the capture is already refunded', async () => {
    const id = seed(); slip(id);
    const done = client({ create: async () => { throw new PayPalError('Already refunded', 422, 'CAPTURE_FULLY_REFUNDED'); } });
    await autoProtectCampaign(done, id, fast);
    expect(refund(id)).toMatchObject({ status: 'FAILED', attempts: MAX_AUTO_ATTEMPTS });
    const later = () => new Date(Date.now() + 86_400_000);
    expect(await autoProtectCampaign(done, id, { ...fast, now: later })).toEqual([]);
    expect(done.refundCapture).toHaveBeenCalledTimes(1);
  });

  it('writes exactly one ledger entry per completed auto-refund with who, what and when', async () => {
    const id = seed({ qty: 2 }); slip(id);
    const paypal = client();
    await autoProtectCampaign(paypal, id, fast);
    await autoProtectCampaign(paypal, id, fast);
    const entries = campaignLedger(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'AUTO_REFUND', actor: 'auto-protect', position: 1, waveNumber: 1, captureId: `CAP${id}`, amountCents: 9600, currency: 'USD',
      oldShipDate: '2026-12-01', newShipDate: '2027-01-15', windowDays: 20, refundId: refundIdFor(refundRequestId(`CAP${id}`, 1)), paypalStatus: 'COMPLETED' });
    expect(entries[0]!.reason).toContain(AUTO_PROTECT_REASON);
  });

  it('does nothing new when the merchant has turned auto-protect off', async () => {
    const id = seed({ autoProtect: 0 }); slip(id);
    const paypal = client();
    expect(await autoProtectCampaign(paypal, id, fast)).toEqual([]);
    expect(paypal.refundCapture).not.toHaveBeenCalled();
    expect(reservation(id).status).toBe('CHARGED');
  });
});

describe('auto-protect ledger actor', () => {
  it('records a merchant retry of an auto-refund as done by the merchant', async () => {
    const id = seed(); slip(id);
    const failing = client({ create: async () => { throw new PayPalError('Refund refused', 422, 'TRANSACTION_REFUSED'); } });
    await autoProtectCampaign(failing, id, fast);
    const { campaign, rows } = slippedCharges(id);
    const result = await settleRefund(client(), refundInputFor(campaign!, rows[0]!, 'auto'), { ...fast, retryFailed: true, actor: 'merchant' });
    expect(result.status).toBe('REFUNDED');
    expect(campaignLedger(id).map(e => [e.kind, e.actor])).toEqual(expect.arrayContaining([['AUTO_REFUND_FAILED', 'auto-protect'], ['AUTO_REFUND', 'merchant']]));
  });
});

describe('auto-protect grace period for drags', () => {
  const t0 = new Date('2026-11-12T15:00:00.000Z');
  const at = (ms: number) => () => new Date(t0.getTime() + ms);
  const wave = (id: string) => db.prepare('SELECT ship_date, date_override FROM waves WHERE campaign_id = ?').get(id) as { ship_date: string; date_override: string | null };
  function drag(id: string, to = '2027-01-15') {
    const before = wave(id);
    db.prepare('UPDATE waves SET ship_date = ?, date_override = ? WHERE campaign_id = ?').run(to, to, id);
    return holdDragRefunds(id, `${id}-w`, { shipDate: before.ship_date, override: before.date_override }, t0);
  }

  it('makes no PayPal call while a drag-triggered slip is inside its grace window', async () => {
    const id = seed(); const hold = drag(id);
    expect(hold).toMatchObject({ refundCount: 1, refundCents: 4800, previousShipDate: '2026-12-01', newShipDate: '2027-01-15' });
    const paypal = client();
    expect(await autoProtectCampaign(paypal, id, { ...fast, now: at(GRACE_MS - 1_000) })).toEqual([]);
    expect(paypal.refundCapture).not.toHaveBeenCalled();
    expect(refund(id)).toBeUndefined();
    expect(reservation(id).status).toBe('CHARGED');
  });

  it('undo inside the window restores the ship date and leaves zero refunds', async () => {
    const id = seed(); const hold = drag(id)!;
    const undone = undoDragHold(id, hold.id, at(30_000)());
    expect(undone.ok).toBe(true);
    expect(wave(id)).toEqual({ ship_date: '2026-12-01', date_override: null });
    expect(activeHolds(id, at(30_000)())).toEqual([]);
    const paypal = client();
    for (const ms of [31_000, GRACE_MS + 1_000, 10 * GRACE_MS]) await autoProtectCampaign(paypal, id, { ...fast, now: at(ms) });
    expect(paypal.refundCapture).not.toHaveBeenCalled();
    expect(refund(id)).toBeUndefined();
    expect(campaignLedger(id)).toEqual([]);
  });

  it('refunds exactly once after the window expires, and undo is then refused', async () => {
    const id = seed(); const hold = drag(id)!;
    const paypal = client();
    await autoProtectCampaign(paypal, id, { ...fast, now: at(GRACE_MS + 1_000) });
    await autoProtectCampaign(paypal, id, { ...fast, now: at(GRACE_MS + 16_000) });
    expect(paypal.refundCapture).toHaveBeenCalledTimes(1);
    expect(reservation(id).status).toBe('RESERVED');
    expect(campaignLedger(id).filter(e => e.kind === 'AUTO_REFUND')).toHaveLength(1);
    expect(undoDragHold(id, hold.id, at(GRACE_MS + 20_000)())).toMatchObject({ ok: false });
    expect(wave(id).ship_date).toBe('2027-01-15');
  });

  it('a second drag inside the window replaces the hold and restarts the clock', async () => {
    const id = seed(); const first = drag(id)!;
    const second = drag(id, '2027-02-01')!;
    expect(undoDragHold(id, first.id, t0)).toMatchObject({ ok: false });
    expect(second.previousShipDate).toBe('2027-01-15');
    expect(activeHolds(id, t0).map(h => h.id)).toEqual([second.id]);
  });

  it('does not hold a drag that leaves every charge inside the window', () => {
    const id = seed();
    expect(drag(id, '2026-12-02')).toBeNull();
  });
});
