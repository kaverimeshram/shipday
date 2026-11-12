import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

// A database from before auto-protect existed, with one live campaign in it.
const dir = mkdtempSync(join(tmpdir(), 'shipday-migrate-'));
const old = new DatabaseSync(join(dir, 'app.db'));
old.exec(`CREATE TABLE campaigns (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, image_url TEXT,
  price_cents INTEGER NOT NULL CHECK(price_cents > 0), currency TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0), ship_date TEXT NOT NULL,
  charge_window_days INTEGER NOT NULL DEFAULT 20 CHECK(charge_window_days >= 0), merchant_key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, archived_at TEXT
);
INSERT INTO campaigns (id, slug, name, price_cents, currency, quantity, ship_date, merchant_key_hash, created_at)
  VALUES ('old', 'old', 'Existing', 100, 'USD', 5, '2026-12-01', 'x', '2026-11-01');`);
old.close();
process.env.DATA_DIR = dir;
const { db } = await import('../src/db.js');

describe('auto-protect migration', () => {
  it('leaves existing campaigns off and starts new campaigns off', () => {
    expect(db.prepare("SELECT auto_protect FROM campaigns WHERE id = 'old'").get()).toEqual({ auto_protect: 0 });
    db.prepare(`INSERT INTO campaigns (id, slug, name, price_cents, currency, quantity, ship_date, merchant_key_hash, created_at)
      VALUES ('new', 'new', 'New', 100, 'USD', 5, '2026-12-01', 'x', '2026-11-12')`).run();
    expect(db.prepare("SELECT auto_protect FROM campaigns WHERE id = 'new'").get()).toEqual({ auto_protect: 0 });
  });
});
