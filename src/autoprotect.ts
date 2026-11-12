import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { outsideChargeWindow } from './domain.js';
import { PayPalError, type PayPalRefund } from './paypal.js';

// Auto-protect: a charge whose wave now ships later than capture day + charge window is refunded
// automatically through the same Payments v2 refund path the merchant button uses.
//
// Double-refund guards, outermost first:
// 1. refunds.charge_attempt_id is UNIQUE, so one capture has exactly one refund row (INSERT OR IGNORE).
// 2. A COMPLETED row is terminal; the sweep never touches it again.
// 3. PayPal-Request-Id is derived from the capture id and the attempt number, so a retry of the same
//    attempt (timeout, crash, 5xx) replays PayPal's original refund instead of creating a second one.
// 4. A FAILED attempt is retried only after re-reading its PayPal refund (check-before-refund), with a
//    new attempt number, after a backoff, and at most MAX_AUTO_ATTEMPTS times automatically.
// 5. A persisted lease (refunds.locked_until) plus an in-process per-campaign queue stop two sweeps
//    from working the same refund at once.

export type RefundClient = {
  refundCapture: (captureId: string, requestId: string) => Promise<PayPalRefund>;
  getRefund: (id: string) => Promise<PayPalRefund>;
};

export const AUTO_PROTECT_REASON = 'auto-protect: wave slipped past charge window';
export const MAX_AUTO_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];
const LEASE_MS = 2 * 60_000;

export const refundRequestId = (captureId: string, attempt: number) => `shipday-refund-${captureId}-${attempt}`;

export type RefundInput = {
  campaignId: string; reservationId: string; attemptId: string; captureId: string; waveId: string | null; waveNumber: number | null;
  source: 'auto' | 'manual'; reason: string; amountCents: number; currency: string;
  oldShipDate: string | null; newShipDate: string | null; windowDays: number; chargedAt: string | null;
};
export type RefundResult = { id: string; status: 'REFUNDED' | 'REFUND_FAILED' | 'REFUND_PENDING' | 'SKIPPED'; refundId?: string | null; issue?: string | null; error?: string; attempt?: number; already?: boolean };
export type SettleOptions = { now?: () => Date; retryFailed?: boolean; pollDelayMs?: (i: number) => number; pollTries?: number };

type RefundRow = { id: string; reservation_id: string; charge_attempt_id: string; capture_id: string; paypal_request_id: string; refund_id: string | null; status: 'PENDING' | 'COMPLETED' | 'FAILED'; reason: string; issue: string | null; source: string; attempts: number; next_attempt_at: string | null; locked_until: string | null };

const refundRow = (attemptId: string) => db.prepare('SELECT * FROM refunds WHERE charge_attempt_id = ?').get(attemptId) as RefundRow | undefined;

function ledger(input: RefundInput, row: RefundRow, kind: 'COMPLETED' | 'FAILED', at: string, paypalStatus: string | null, issue: string | null) {
  const auto = row.source === 'auto';
  const entryKind = auto ? (kind === 'COMPLETED' ? 'AUTO_REFUND' : 'AUTO_REFUND_FAILED') : (kind === 'COMPLETED' ? 'REFUND' : 'REFUND_FAILED');
  const key = kind === 'COMPLETED' ? `refund:${row.id}:completed` : `refund:${row.id}:failed:${row.attempts}`;
  db.prepare(`INSERT OR IGNORE INTO ledger_entries (id, campaign_id, reservation_id, refund_row_id, wave_id, wave_number, capture_id, kind, actor, amount_cents, currency,
    old_ship_date, new_ship_date, window_days, charged_at, reason, paypal_refund_id, paypal_status, issue, attempt, dedupe_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), input.campaignId, input.reservationId, row.id, input.waveId, input.waveNumber, input.captureId, entryKind, auto ? 'auto-protect' : 'merchant',
      input.amountCents, input.currency, input.oldShipDate, input.newShipDate, input.windowDays, input.chargedAt, row.reason, row.refund_id, paypalStatus, issue, row.attempts, key, at);
}

function complete(input: RefundInput, row: RefundRow, refundId: string, at: string): RefundResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const done = db.prepare("UPDATE refunds SET status = 'COMPLETED', refund_id = ?, completed_at = ?, locked_until = NULL, issue = NULL WHERE id = ? AND status != 'COMPLETED'").run(refundId, at, row.id);
    if (Number(done.changes) > 0) {
      db.prepare(`UPDATE reservations SET status = 'RESERVED', capture_id = NULL, paypal_order_id = NULL, paypal_issue = NULL,
        tracking_request_id = NULL, tracking_number = NULL, carrier = NULL WHERE id = ? AND status = 'CHARGED'`).run(input.reservationId);
      ledger(input, { ...row, refund_id: refundId }, 'COMPLETED', at, 'COMPLETED', null);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { id: input.reservationId, status: 'REFUNDED', refundId, attempt: row.attempts };
}

function fail(input: RefundInput, row: RefundRow, issue: string, now: Date, paypalStatus: string | null, stopAutoRetry = false): RefundResult {
  const next = new Date(now.getTime() + RETRY_BACKOFF_MS[Math.min(row.attempts - 1, RETRY_BACKOFF_MS.length - 1)]!).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE refunds SET status = 'FAILED', issue = ?, next_attempt_at = ?, locked_until = NULL, attempts = CASE WHEN ? THEN MAX(attempts, ?) ELSE attempts END WHERE id = ? AND status = 'PENDING'")
      .run(issue, next, stopAutoRetry ? 1 : 0, MAX_AUTO_ATTEMPTS, row.id);
    ledger(input, row, 'FAILED', now.toISOString(), paypalStatus, issue);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { id: input.reservationId, status: 'REFUND_FAILED', refundId: row.refund_id, issue, attempt: row.attempts };
}

// Creates or resumes the one refund for a capture. Safe to call any number of times.
export async function settleRefund(client: RefundClient, input: RefundInput, options: SettleOptions = {}): Promise<RefundResult> {
  const now = options.now ?? (() => new Date());
  const delay = options.pollDelayMs ?? (i => Math.min(500 * 2 ** i, 4000));
  db.prepare(`INSERT OR IGNORE INTO refunds (id, reservation_id, charge_attempt_id, capture_id, paypal_request_id, status, reason, created_at, source, attempts,
    wave_id, old_ship_date, new_ship_date, amount_cents, currency) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), input.reservationId, input.attemptId, input.captureId, refundRequestId(input.captureId, 1), input.reason, now().toISOString(), input.source,
      input.waveId, input.oldShipDate, input.newShipDate, input.amountCents, input.currency);
  let row = refundRow(input.attemptId)!;
  if (row.status === 'COMPLETED') return { id: input.reservationId, status: 'REFUNDED', refundId: row.refund_id, already: true, attempt: row.attempts };
  if (row.status === 'FAILED') {
    if (!options.retryFailed) return { id: input.reservationId, status: 'REFUND_FAILED', refundId: row.refund_id, issue: row.issue, attempt: row.attempts };
    // Check before refunding again: a refund PayPal reported late may have completed after all.
    if (row.refund_id) {
      try {
        const read = await client.getRefund(row.refund_id);
        if (read.status === 'COMPLETED') return complete(input, row, read.id, now().toISOString());
        if (read.status === 'PENDING') {
          db.prepare("UPDATE refunds SET status = 'PENDING', issue = NULL WHERE id = ? AND status = 'FAILED'").run(row.id);
          return { id: input.reservationId, status: 'REFUND_PENDING', refundId: row.refund_id, attempt: row.attempts };
        }
      } catch (error) {
        if (!(error instanceof PayPalError && error.status === 404)) return { id: input.reservationId, status: 'REFUND_FAILED', refundId: row.refund_id, issue: row.issue, error: 'PayPal refund readback failed; will retry.', attempt: row.attempts };
      }
    }
    const attempt = row.attempts + 1;
    const reset = db.prepare("UPDATE refunds SET status = 'PENDING', attempts = ?, paypal_request_id = ?, refund_id = NULL, issue = NULL, next_attempt_at = NULL WHERE id = ? AND status = 'FAILED' AND attempts = ?")
      .run(attempt, refundRequestId(input.captureId, attempt), row.id, row.attempts);
    if (Number(reset.changes) === 0) return { id: input.reservationId, status: 'REFUND_PENDING', error: 'Another refund attempt is already in progress.' };
    row = refundRow(input.attemptId)!;
  }
  const claimed = db.prepare("UPDATE refunds SET locked_until = ? WHERE id = ? AND status = 'PENDING' AND (locked_until IS NULL OR locked_until < ?)")
    .run(new Date(now().getTime() + LEASE_MS).toISOString(), row.id, now().toISOString());
  if (Number(claimed.changes) === 0) return { id: input.reservationId, status: 'REFUND_PENDING', refundId: row.refund_id, error: 'This refund is already being processed.', attempt: row.attempts };
  const release = () => db.prepare('UPDATE refunds SET locked_until = NULL WHERE id = ?').run(row.id);
  try {
    if (!row.refund_id) {
      const created = await client.refundCapture(input.captureId, row.paypal_request_id);
      db.prepare('UPDATE refunds SET refund_id = ? WHERE id = ?').run(created.id, row.id);
      row.refund_id = created.id;
    }
    const tries = options.pollTries ?? 6;
    for (let i = 0; i < tries; i++) {
      // Read the refund back: only PayPal's own COMPLETED readback marks money as returned.
      const read = await client.getRefund(row.refund_id!);
      if (read.status === 'COMPLETED') return complete(input, row, read.id, now().toISOString());
      if (['FAILED', 'CANCELLED'].includes(read.status)) return fail(input, row, read.status_details?.reason || read.status, now(), read.status);
      const ms = delay(i);
      if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
    }
    release();
    return { id: input.reservationId, status: 'REFUND_PENDING', refundId: row.refund_id, error: 'PayPal has not completed the refund yet. Shipday will keep checking.', attempt: row.attempts };
  } catch (error) {
    if (error instanceof PayPalError && [400, 403, 404, 422].includes(error.status)) {
      // PayPal says the capture is already refunded: never try again automatically, a person must reconcile it.
      const settled = ['CAPTURE_FULLY_REFUNDED', 'REFUND_AMOUNT_EXCEEDED'].includes(error.issue || '');
      return fail(input, row, error.issue || error.message, now(), null, settled);
    }
    release();
    return { id: input.reservationId, status: 'REFUND_PENDING', refundId: row.refund_id, error: error instanceof Error ? error.message : 'PayPal refund is still being reconciled.', attempt: row.attempts };
  }
}

type Candidate = {
  reservation_id: string; position: number; qty: number; capture_id: string; attempt_id: string; completed_at: string; ship_date_at_charge: string | null;
  wave_id: string; wave_number: number; ship_date: string; refund_status: string | null; attempts: number | null; next_attempt_at: string | null; refund_source: string | null;
};

// Charges that now ship outside their window, with any refund already on file for them.
export function slippedCharges(campaignId: string) {
  const campaign = db.prepare('SELECT id, price_cents, currency, charge_window_days, auto_protect FROM campaigns WHERE id = ?').get(campaignId) as { id: string; price_cents: number; currency: string; charge_window_days: number; auto_protect: number } | undefined;
  if (!campaign) return { campaign: undefined, rows: [] as Candidate[] };
  const rows = (db.prepare(`SELECT r.id AS reservation_id, r.position, r.qty, r.capture_id, a.id AS attempt_id, a.completed_at, a.ship_date_at_charge,
      w.id AS wave_id, w.number AS wave_number, w.ship_date, f.status AS refund_status, f.attempts, f.next_attempt_at, f.source AS refund_source
    FROM reservations r JOIN charge_attempts a ON a.capture_id = r.capture_id AND a.status = 'COMPLETED' JOIN waves w ON w.id = r.wave_id
    LEFT JOIN refunds f ON f.charge_attempt_id = a.id
    WHERE r.campaign_id = ? AND r.status = 'CHARGED' ORDER BY r.position`).all(campaignId) as Candidate[])
    .filter(row => row.completed_at && outsideChargeWindow(row.completed_at, row.ship_date, campaign.charge_window_days));
  return { campaign, rows };
}

export function refundInputFor(campaign: { id: string; price_cents: number; currency: string; charge_window_days: number }, row: Candidate, source: 'auto' | 'manual', previousShipDates?: Map<string, string>): RefundInput {
  const oldShipDate = row.ship_date_at_charge ?? previousShipDates?.get(row.wave_id) ?? null;
  const charged = row.completed_at.slice(0, 10);
  const detail = `Wave ${row.wave_number} ship date moved ${oldShipDate ? `from ${oldShipDate} ` : ''}to ${row.ship_date}, more than ${campaign.charge_window_days} days after the ${charged} charge.`;
  return {
    campaignId: campaign.id, reservationId: row.reservation_id, attemptId: row.attempt_id, captureId: row.capture_id, waveId: row.wave_id, waveNumber: row.wave_number,
    source, reason: source === 'auto' ? `${AUTO_PROTECT_REASON}. ${detail}` : `Ship date moved to ${row.ship_date}, more than ${campaign.charge_window_days} days after the ${charged} charge.`,
    amountCents: campaign.price_cents * row.qty, currency: campaign.currency, oldShipDate, newShipDate: row.ship_date, windowDays: campaign.charge_window_days, chargedAt: row.completed_at,
  };
}

const queues = new Map<string, Promise<unknown>>();

// Run auto-protect for one campaign. Calls for the same campaign run one after another, never together.
export function autoProtectCampaign(client: RefundClient, campaignId: string, options: SettleOptions & { previousShipDates?: Map<string, string> } = {}): Promise<RefundResult[]> {
  const run = async () => {
    const now = options.now ?? (() => new Date());
    const { campaign, rows } = slippedCharges(campaignId);
    if (!campaign) return [];
    const results: RefundResult[] = [];
    for (const row of rows) {
      if (row.refund_status === 'COMPLETED') continue;
      const enabled = campaign.auto_protect === 1;
      // A refund already in flight is always finished; new refunds and retries follow the toggle.
      if (row.refund_status !== 'PENDING' && !enabled) continue;
      if (row.refund_status === 'FAILED') {
        if ((row.attempts ?? 1) >= MAX_AUTO_ATTEMPTS) continue;
        if (row.next_attempt_at && Date.parse(row.next_attempt_at) > now().getTime()) continue;
      }
      const source = row.refund_source === 'manual' ? 'manual' : 'auto';
      results.push(await settleRefund(client, refundInputFor(campaign, row, source, options.previousShipDates), { ...options, retryFailed: true }));
    }
    return results;
  };
  const next = (queues.get(campaignId) ?? Promise.resolve()).catch(() => undefined).then(run);
  queues.set(campaignId, next);
  void next.finally(() => { if (queues.get(campaignId) === next) queues.delete(campaignId); }).catch(() => undefined);
  return next;
}

// Periodic safety net: every campaign with a charged reservation or an unfinished refund.
export async function sweepAutoProtect(client: RefundClient, options: SettleOptions = {}) {
  const ids = (db.prepare(`SELECT DISTINCT r.campaign_id AS id FROM reservations r JOIN campaigns c ON c.id = r.campaign_id
    WHERE c.archived_at IS NULL AND r.status = 'CHARGED'`).all() as { id: string }[]).map(r => r.id);
  const out: { campaignId: string; results: RefundResult[] }[] = [];
  for (const id of ids) {
    try { out.push({ campaignId: id, results: await autoProtectCampaign(client, id, options) }); }
    catch (error) { console.error('Shipday auto-protect sweep failed', { campaignId: id, name: error instanceof Error ? error.name : 'Error' }); }
  }
  return out;
}

export type LedgerEntry = { id: string; kind: string; actor: string; reservationId: string; position: number | null; waveId: string | null; waveNumber: number | null; captureId: string | null;
  amountCents: number | null; currency: string | null; oldShipDate: string | null; newShipDate: string | null; windowDays: number | null; chargedAt: string | null;
  reason: string; refundId: string | null; paypalStatus: string | null; issue: string | null; attempt: number; at: string };

export function campaignLedger(campaignId: string): LedgerEntry[] {
  return (db.prepare(`SELECT l.*, r.position FROM ledger_entries l LEFT JOIN reservations r ON r.id = l.reservation_id WHERE l.campaign_id = ? ORDER BY l.created_at DESC, l.id`).all(campaignId) as any[])
    .map(l => ({ id: l.id, kind: l.kind, actor: l.actor, reservationId: l.reservation_id, position: l.position ?? null, waveId: l.wave_id, waveNumber: l.wave_number, captureId: l.capture_id,
      amountCents: l.amount_cents, currency: l.currency, oldShipDate: l.old_ship_date, newShipDate: l.new_ship_date, windowDays: l.window_days, chargedAt: l.charged_at,
      reason: l.reason, refundId: l.paypal_refund_id, paypalStatus: l.paypal_status, issue: l.issue, attempt: l.attempt, at: l.created_at }));
}

// Finish every refund already in flight (PENDING), whatever the plan says now: PayPal may have received it.
export async function resumePendingRefunds(client: RefundClient, options: SettleOptions = {}) {
  const rows = db.prepare(`SELECT f.*, r.campaign_id, r.qty, c.price_cents, c.currency AS campaign_currency, c.charge_window_days, a.completed_at AS charged_at, w.number AS wave_number, w.ship_date AS wave_ship_date
    FROM refunds f JOIN reservations r ON r.id = f.reservation_id JOIN campaigns c ON c.id = r.campaign_id JOIN charge_attempts a ON a.id = f.charge_attempt_id
    LEFT JOIN waves w ON w.id = COALESCE(f.wave_id, r.wave_id) WHERE f.status = 'PENDING'`).all() as any[];
  const out: { campaignId: string; result: RefundResult }[] = [];
  for (const row of rows) {
    const input: RefundInput = {
      campaignId: row.campaign_id, reservationId: row.reservation_id, attemptId: row.charge_attempt_id, captureId: row.capture_id, waveId: row.wave_id, waveNumber: row.wave_number ?? null,
      source: row.source === 'auto' ? 'auto' : 'manual', reason: row.reason, amountCents: row.amount_cents ?? row.price_cents * row.qty, currency: row.currency ?? row.campaign_currency,
      oldShipDate: row.old_ship_date, newShipDate: row.new_ship_date ?? row.wave_ship_date ?? null, windowDays: row.charge_window_days, chargedAt: row.charged_at,
    };
    try { out.push({ campaignId: row.campaign_id, result: await settleRefund(client, input, options) }); }
    catch (error) { console.error('Shipday refund reconciliation failed', { name: error instanceof Error ? error.name : 'Error' }); }
  }
  return out;
}
