import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipday-db-'));
const { db, campaignAllocations, hasLiveCapture } = await import('../src/db.js');

function seed(campaign: string) {
  db.prepare(`INSERT INTO campaigns (id, slug, name, price_cents, currency, quantity, ship_date, merchant_key_hash, created_at)
    VALUES (?, ?, 'Game', 100, 'USD', 5, '2026-12-01', 'x', '2026-11-12')`).run(campaign, campaign);
  db.prepare(`INSERT INTO reservations (id, campaign_id, email, qty, position, status, created_at) VALUES (?, ?, 'a@b.co', 1, 1, 'RESERVED', '2026-11-12')`).run(`${campaign}-r`, campaign);
  db.prepare(`INSERT INTO waves (id, campaign_id, number, units, ship_date) VALUES (?, ?, 1, 1, '2026-12-01')`).run(`${campaign}-w`, campaign);
  db.prepare('INSERT INTO reservation_allocations (reservation_id, wave_id, qty) VALUES (?, ?, 1)').run(`${campaign}-r`, `${campaign}-w`);
}

describe('campaign allocations', () => {
  it('returns only the allocations of the requested campaign', () => {
    seed('c1'); seed('c2');
    expect(campaignAllocations('c1')).toEqual([{ reservationId: 'c1-r', waveId: 'c1-w', qty: 1 }]);
  });
});

describe('live capture guard', () => {
  it('blocks a second charge until the completed capture is refunded', () => {
    seed('c3');
    db.prepare(`INSERT INTO charge_attempts (id, reservation_id, paypal_request_id, capture_request_id, capture_id, status, created_at, completed_at)
      VALUES ('a3', 'c3-r', 'p3', 'q3', 'cap3', 'COMPLETED', '2026-11-12', '2026-11-12')`).run();
    expect(hasLiveCapture('c3-r')).toBe(true);
    db.prepare(`INSERT INTO refunds (id, reservation_id, charge_attempt_id, capture_id, paypal_request_id, status, reason, created_at)
      VALUES ('f3', 'c3-r', 'a3', 'cap3', 'rq3', 'PENDING', 'slip', '2026-11-13')`).run();
    expect(hasLiveCapture('c3-r')).toBe(true);
    db.prepare("UPDATE refunds SET status = 'COMPLETED', refund_id = 'ref3' WHERE id = 'f3'").run();
    expect(hasLiveCapture('c3-r')).toBe(false);
  });
});
