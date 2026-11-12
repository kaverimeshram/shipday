import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const file = resolve(process.env.DATA_DIR || './data', 'app.db');
mkdirSync(dirname(file), { recursive: true });
export const db = new DatabaseSync(file);
db.exec(`
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, image_url TEXT,
  price_cents INTEGER NOT NULL CHECK(price_cents > 0), currency TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0), ship_date TEXT NOT NULL,
  charge_window_days INTEGER NOT NULL DEFAULT 20 CHECK(charge_window_days >= 0), merchant_key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  setup_token_id TEXT UNIQUE, vault_id TEXT UNIQUE, customer_id TEXT, email TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK(qty > 0), position INTEGER NOT NULL, wave_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','RESERVED','CANCEL_PENDING','CANCELLED','CHARGE_PENDING','DECLINED','CHARGED','SHIPPED')),
  paypal_order_id TEXT, capture_id TEXT UNIQUE, request_id TEXT UNIQUE, paypal_issue TEXT,
  setup_request_id TEXT UNIQUE, payment_request_id TEXT UNIQUE, cancel_request_id TEXT UNIQUE, tracking_request_id TEXT UNIQUE,
  tracking_number TEXT, carrier TEXT, created_at TEXT NOT NULL,
  UNIQUE(campaign_id, position)
);
CREATE TABLE IF NOT EXISTS supply_updates (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), source TEXT NOT NULL,
  units INTEGER NOT NULL, milestone TEXT NOT NULL, event_date TEXT NOT NULL,
  origin TEXT, destination TEXT, vessel_or_carrier TEXT,
  quotes TEXT NOT NULL, confidence REAL NOT NULL, confirmed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS waves (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  number INTEGER NOT NULL, units INTEGER NOT NULL, ship_date TEXT NOT NULL, date_override TEXT,
  UNIQUE(campaign_id, number)
);
CREATE INDEX IF NOT EXISTS reservations_campaign_position ON reservations(campaign_id, position);
CREATE INDEX IF NOT EXISTS reservations_wave ON reservations(wave_id, status);
CREATE INDEX IF NOT EXISTS supply_campaign ON supply_updates(campaign_id, confirmed_at);
CREATE TABLE IF NOT EXISTS reservation_allocations (
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  wave_id TEXT NOT NULL REFERENCES waves(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL CHECK(qty > 0),
  PRIMARY KEY(reservation_id, wave_id)
);
CREATE TABLE IF NOT EXISTS charge_attempts (
  id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES reservations(id),
  paypal_request_id TEXT NOT NULL UNIQUE, capture_request_id TEXT NOT NULL UNIQUE,
  paypal_order_id TEXT, capture_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('PENDING','COMPLETED','DECLINED')),
  issue TEXT, created_at TEXT NOT NULL, completed_at TEXT,
  UNIQUE(reservation_id, paypal_request_id)
);
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES reservations(id),
  charge_attempt_id TEXT NOT NULL UNIQUE REFERENCES charge_attempts(id), capture_id TEXT NOT NULL UNIQUE,
  paypal_request_id TEXT NOT NULL UNIQUE, refund_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('PENDING','COMPLETED','FAILED')),
  reason TEXT NOT NULL, issue TEXT, created_at TEXT NOT NULL, completed_at TEXT
);
`);

if (!(db.prepare('PRAGMA table_info(reservations)').all() as { name: string }[]).some(c => c.name === 'payment_kind')) {
  db.exec("ALTER TABLE reservations ADD COLUMN payment_kind TEXT NOT NULL DEFAULT 'paypal' CHECK(payment_kind IN ('paypal','card'))");
}

export function hasLiveCapture(reservationId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM charge_attempts a WHERE a.reservation_id = ? AND a.status = 'COMPLETED'
    AND NOT EXISTS (SELECT 1 FROM refunds f WHERE f.charge_attempt_id = a.id AND f.status = 'COMPLETED')`).get(reservationId));
}

export function campaignAllocations(campaignId: string) {
  return db.prepare(`SELECT a.reservation_id AS reservationId, a.wave_id AS waveId, a.qty FROM reservation_allocations a
    JOIN waves w ON w.id = a.wave_id WHERE w.campaign_id = ? ORDER BY a.wave_id, a.reservation_id`).all(campaignId) as { reservationId: string; waveId: string; qty: number }[];
}
