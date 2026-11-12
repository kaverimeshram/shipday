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
  created_at TEXT NOT NULL, archived_at TEXT
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

if (!(db.prepare('PRAGMA table_info(campaigns)').all() as { name: string }[]).some(c => c.name === 'archived_at')) {
  db.exec('ALTER TABLE campaigns ADD COLUMN archived_at TEXT');
}

if (!(db.prepare('PRAGMA table_info(campaigns)').all() as { name: string }[]).some(c => c.name === 'description')) {
  db.exec('ALTER TABLE campaigns ADD COLUMN description TEXT');
}

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

// Auto-protect: refund lifecycle, retry bookkeeping, and the money ledger.
function addColumn(table: string, column: string, ddl: string) {
  if (!(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumn('campaigns', 'auto_protect', 'auto_protect INTEGER NOT NULL DEFAULT 0');
addColumn('charge_attempts', 'ship_date_at_charge', 'ship_date_at_charge TEXT');
addColumn('refunds', 'source', "source TEXT NOT NULL DEFAULT 'manual'");
addColumn('refunds', 'attempts', 'attempts INTEGER NOT NULL DEFAULT 1');
addColumn('refunds', 'next_attempt_at', 'next_attempt_at TEXT');
addColumn('refunds', 'locked_until', 'locked_until TEXT');
addColumn('refunds', 'wave_id', 'wave_id TEXT');
addColumn('refunds', 'old_ship_date', 'old_ship_date TEXT');
addColumn('refunds', 'new_ship_date', 'new_ship_date TEXT');
addColumn('refunds', 'amount_cents', 'amount_cents INTEGER');
addColumn('refunds', 'currency', 'currency TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), reservation_id TEXT NOT NULL REFERENCES reservations(id),
  refund_row_id TEXT REFERENCES refunds(id), wave_id TEXT, wave_number INTEGER, capture_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('AUTO_REFUND','AUTO_REFUND_FAILED','REFUND','REFUND_FAILED')), actor TEXT NOT NULL,
  amount_cents INTEGER, currency TEXT, old_ship_date TEXT, new_ship_date TEXT, window_days INTEGER, charged_at TEXT,
  reason TEXT NOT NULL, paypal_refund_id TEXT, paypal_status TEXT, issue TEXT, attempt INTEGER NOT NULL DEFAULT 1,
  dedupe_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_campaign ON ledger_entries(campaign_id, created_at);
`);
// Auto-protect grace period: a drag that makes charges slip holds their refunds for an undo window.
db.exec(`
CREATE TABLE IF NOT EXISTS replan_holds (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), wave_id TEXT NOT NULL,
  previous_ship_date TEXT NOT NULL, previous_override TEXT, new_ship_date TEXT NOT NULL,
  refund_count INTEGER NOT NULL, refund_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('HOLDING','UNDONE','SUPERSEDED')),
  hold_until TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS replan_holds_wave ON replan_holds(wave_id, status);
`);
