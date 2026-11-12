import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import { getCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { campaignAllocations, db, hasLiveCapture } from './db.js';
import { AIError, extractShipments, extractSupply, explainPlan, type SupplyExtraction } from './ai.js';
import { chargeRefusal, ganttDependencies, ganttTasks, isChargeEligible, matchShipments, milestones, moveWave, outsideChargeWindow, planWaves, type Milestone } from './domain.js';
import { PayPalError, addTracking, orderHasTracker, captureOrder, createCardSetupToken, createPaymentToken, createSetupToken, createVaultOrder, deletePaymentToken, getOrder, getPaymentToken, getPaymentTokenForCancelCheck, getRefund, newRequestId, refundCapture, verifyWebhookSignature, type PayPalOrder } from './paypal.js';
import { paypalPolicy } from './policy.js';
import { imageType, storeCampaignImage } from './image.js';

const app = new Hono();
app.use('/api/*', cors({ origin: publicUrl(), allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type'], credentials: true }));
const clients = new Set<(message: unknown) => void>();
const nowIso = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest();
const cookieName = (slug: string) => `shipday_${slug}`;

function emit(type: string, slug: string) {
  for (const send of clients) send({ type, slug, at: nowIso() });
}

function publicUrl() {
  return (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '8787'}`).replace(/\/$/, '');
}

function missingConfig() {
  return [
    ...(!process.env.PAYPAL_CLIENT_ID ? ['PAYPAL_CLIENT_ID'] : []),
    ...(!process.env.PAYPAL_CLIENT_SECRET ? ['PAYPAL_CLIENT_SECRET'] : []),
    ...(!process.env.OPENROUTER_API_KEY ? ['OPENROUTER_API_KEY'] : []),
  ];
}

type CampaignRow = {
  id: string; slug: string; name: string; description: string | null; image_url: string | null; price_cents: number; currency: string;
  quantity: number; ship_date: string; charge_window_days: number; merchant_key_hash: Uint8Array; created_at: string;
};
const campaignBySlug = (slug: string) => db.prepare('SELECT * FROM campaigns WHERE slug = ? AND archived_at IS NULL').get(slug) as CampaignRow | undefined;

function hasMerchantKey(c: any, campaign: CampaignRow) {
  const token = getCookie(c, cookieName(campaign.slug));
  if (!token) return false;
  const supplied = hash(token);
  const saved = Buffer.from(campaign.merchant_key_hash);
  return supplied.length === saved.length && timingSafeEqual(supplied, saved);
}

function requireCampaign(c: any, slug: string, merchant = false): CampaignRow | Response {
  const campaign = campaignBySlug(slug);
  if (!campaign) return c.json({ error: 'Campaign not found.' }, 404);
  if (merchant) {
    const token = getCookie(c, cookieName(campaign.slug));
    if (!token || !hasMerchantKey(c, campaign)) return c.json({ error: 'Open this campaign in the merchant browser that created it.' }, 401);
    setCookie(c, cookieName(campaign.slug), token, { httpOnly: true, sameSite: 'Strict', secure: publicUrl().startsWith('https:'), path: '/', maxAge: 31_536_000 });
  }
  return campaign;
}

function asCampaign(result: CampaignRow | Response): result is CampaignRow {
  return !(result instanceof Response);
}

function campaignAvailability(id: string) {
  const cutoff = new Date(Date.now() - 3 * 86_400_000).toISOString();
  db.prepare("UPDATE reservations SET status = 'CANCELLED' WHERE campaign_id = ? AND status = 'PENDING' AND created_at < ?").run(id, cutoff);
  return db.prepare("SELECT COALESCE(SUM(qty), 0) AS reserved FROM reservations WHERE campaign_id = ? AND status != 'CANCELLED'").get(id) as { reserved: number };
}

const CampaignInput = z.object({
  name: z.string().trim().min(2).max(100), description: z.string().trim().max(600).optional().transform(v => v || null), imageUrl: z.string().url().optional().or(z.literal('')),
  priceCents: z.number().int().min(1).max(100_000_000), currency: z.string().regex(/^[A-Z]{3}$/),
  quantity: z.number().int().min(1).max(100_000), shipDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  chargeWindowDays: z.number().int().min(0).max(365).default(20),
});
const ReserveInput = z.object({ email: z.email(), qty: z.number().int().min(1).max(100) });
const ConfirmInput = z.object({
  source: z.string().max(100_000).default(''), units: z.number().int().min(1), milestone: z.enum(milestones),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), origin: z.string().max(300).nullable(), destination: z.string().max(300).nullable(),
  vesselOrCarrier: z.string().max(300).nullable(), quotes: z.array(z.string().min(1).max(1000)).min(1).max(20),
  confidence: z.number().min(0).max(1),
});
const MoveInput = z.object({ shipDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const TrackingInput = z.object({ items: z.array(z.object({ reservationId: z.uuid(), trackingNumber: z.string().trim().min(3).max(100), carrier: z.string().trim().min(1).max(40) })).min(1) });

app.get('/api/health', c => c.json({ ok: true, missing: missingConfig() }));
app.get('/api/config', c => c.json({ missing: missingConfig(), bryntumLicense: process.env.BRYNTUM_LICENSE || null, cardEntry: process.env.PAYPAL_ENV !== 'live', demoSlug: process.env.DEMO_CAMPAIGN_SLUG || null }));

app.get('/media/:id', async c => {
  const id = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.text('Not found', 404);
  try {
    const bytes = await readFile(resolve(process.env.DATA_DIR || './data', 'uploads', id));
    const type = imageType(bytes);
    if (!type) return c.text('Not found', 404);
    return new Response(bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
  } catch { return c.text('Not found', 404); }
});

app.get('/api/campaigns', c => {
  const rows = db.prepare(`SELECT c.*, COALESCE(SUM(CASE WHEN r.status != 'CANCELLED' THEN r.qty ELSE 0 END), 0) AS reserved
    FROM campaigns c LEFT JOIN reservations r ON r.campaign_id = c.id WHERE c.archived_at IS NULL
    GROUP BY c.id ORDER BY c.created_at DESC`).all() as any[];
  return c.json(rows.filter(row => hasMerchantKey(c, row)).map(row => ({ id: row.id, slug: row.slug, name: row.name, imageUrl: row.image_url,
    priceCents: row.price_cents, currency: row.currency, quantity: row.quantity, shipDate: row.ship_date, chargeWindowDays: row.charge_window_days,
    reserved: row.reserved, available: Math.max(0, row.quantity - row.reserved) })));
});

app.post('/api/campaigns/:slug/archive', c => {
  const campaign = requireCampaign(c, c.req.param('slug'), true);
  if (!asCampaign(campaign)) return campaign;
  if (campaignAvailability(campaign.id).reserved > 0) return c.json({ error: 'A campaign with active reservations cannot be archived.' }, 409);
  db.prepare('UPDATE campaigns SET archived_at = ? WHERE id = ?').run(nowIso(), campaign.id);
  return c.json({ status: 'ARCHIVED' });
});

app.get('/api/events', c => streamSSE(c, async stream => {
  const send = (message: unknown) => { void stream.writeSSE({ event: 'update', data: JSON.stringify(message) }); };
  clients.add(send);
  let close = () => {};
  const done = new Promise<void>(resolve => { close = resolve; });
  stream.onAbort(() => { clients.delete(send); close(); });
  await done;
}));

app.post('/api/campaigns', bodyLimit({ maxSize: 5 * 1024 * 1024 + 65_536 }), async c => {
  const multipart = c.req.header('content-type')?.startsWith('multipart/form-data');
  let body: any;
  if (multipart) {
    const form = await c.req.formData();
    body = Object.fromEntries(form.entries());
  } else body = await c.req.json();
  if (multipart) {
    for (const key of ['priceCents', 'quantity', 'chargeWindowDays']) body[key] = Number(body[key]);
  }
  const image = multipart && body.image instanceof File && body.image.size ? body.image : null;
  delete body.image;
  const parsed = CampaignInput.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Campaign details are invalid.' }, 400);
  const input = parsed.data;
  let storedImage: Awaited<ReturnType<typeof storeCampaignImage>> | null = null;
  try { if (image) storedImage = await storeCampaignImage(image); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Product image could not be stored.' }, 400); }
  const id = randomUUID();
  const slug = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 35)}-${randomBytes(3).toString('hex')}`;
  const merchantKey = randomBytes(32).toString('base64url');
  try {
    db.prepare(`INSERT INTO campaigns (id, slug, name, description, image_url, price_cents, currency, quantity, ship_date, charge_window_days, merchant_key_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, slug, input.name, input.description, storedImage?.path || input.imageUrl || null, input.priceCents, input.currency, input.quantity, input.shipDate, input.chargeWindowDays, hash(merchantKey), nowIso());
  } catch (error) {
    if (storedImage) await storedImage.cleanup();
    throw error;
  }
  setCookie(c, cookieName(slug), merchantKey, {
    httpOnly: true, sameSite: 'Strict', secure: publicUrl().startsWith('https:'), path: '/', maxAge: 31_536_000,
  });
  emit('campaign', slug);
  return c.json({ id, slug, path: `/merchant/${slug}` }, 201);
});

app.get('/api/campaigns/:slug', c => {
  const campaign = campaignBySlug(c.req.param('slug'));
  if (!campaign) return c.json({ error: 'Campaign not found.' }, 404);
  const { reserved } = campaignAvailability(campaign.id);
  return c.json({ id: campaign.id, slug: campaign.slug, name: campaign.name, description: campaign.description, imageUrl: campaign.image_url, priceCents: campaign.price_cents, currency: campaign.currency, quantity: campaign.quantity, available: Math.max(0, campaign.quantity - reserved), shipDate: campaign.ship_date, chargeWindowDays: campaign.charge_window_days, policy: paypalPolicy });
});

app.post('/api/campaigns/:slug/reservations', async c => {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) return c.json({ error: 'PayPal setup is required to reserve. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.' }, 503);
  const campaign = campaignBySlug(c.req.param('slug'));
  if (!campaign) return c.json({ error: 'Campaign not found.' }, 404);
  const parsed = ReserveInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Reservation details are invalid.' }, 400);
  const { email, qty } = parsed.data;
  const reserved = campaignAvailability(campaign.id).reserved;
  if (reserved + qty > campaign.quantity) return c.json({ error: 'There are not enough units left for this reservation.' }, 409);
  const id = randomUUID();
  const setupRequestId = newRequestId();
  const position = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM reservations WHERE campaign_id = ?').get(campaign.id) as { next: number }).next;
  db.prepare(`INSERT INTO reservations (id, campaign_id, email, qty, position, status, setup_request_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`)
    .run(id, campaign.id, email.toLowerCase(), qty, position, setupRequestId, nowIso());
  try {
    const result = await createSetupToken({
      campaignName: campaign.name,
      returnUrl: `${publicUrl()}/api/paypal/approved`,
      cancelUrl: `${publicUrl()}/r/${id}?payment=cancelled`,
    }, setupRequestId);
    const approvalUrl = result.links?.find(link => link.rel === 'approve')?.href;
    if (result.status !== 'PAYER_ACTION_REQUIRED' || !approvalUrl) throw new Error('PayPal did not return a buyer approval link.');
    db.prepare('UPDATE reservations SET setup_token_id = ? WHERE id = ?').run(result.id, id);
    return c.json({ reservationId: id, setupTokenId: result.id, setupStatus: result.status, approvalUrl }, 201);
  } catch (error) { return errorResponse(c, error); }
});

async function saveVault(reservation: any, setupId: string): Promise<'RESERVED' | 'CANCELLED'> {
  const paymentRequestId = reservation.payment_request_id || newRequestId();
  db.prepare('UPDATE reservations SET payment_request_id = ? WHERE id = ? AND payment_request_id IS NULL').run(paymentRequestId, reservation.id);
  const created = await createPaymentToken(setupId, paymentRequestId);
  const token = await getPaymentToken(created.id);
  if (token.id !== created.id || !token.customer?.id) throw new Error('PayPal payment token readback did not confirm the customer and token.');
  const campaign = db.prepare('SELECT slug FROM campaigns WHERE id = ?').get(reservation.campaign_id) as { slug: string };
  const finalized = db.prepare(`UPDATE reservations SET vault_id = ?, customer_id = ?, email = ?, status = 'RESERVED' WHERE id = ? AND status = 'PENDING'`)
    .run(token.id, token.customer.id, token.payment_source?.paypal?.email_address || reservation.email, reservation.id);
  if (Number(finalized.changes) === 0) {
    const cancelId = newRequestId();
    db.prepare('UPDATE reservations SET cancel_request_id = ? WHERE id = ? AND cancel_request_id IS NULL').run(cancelId, reservation.id);
    await deletePaymentToken(token.id, cancelId);
    if (await getPaymentTokenForCancelCheck(token.id)) throw new Error('Reservation was cancelled, but PayPal still returns the saved payment token.');
    emit('reservation', campaign.slug);
    return 'CANCELLED';
  }
  emit('reservation', campaign.slug);
  return 'RESERVED';
}

app.get('/api/paypal/approved', async c => {
  const setupId = c.req.query('token');
  if (!setupId) return c.redirect('/?paypal=missing-token');
  const reservation = db.prepare("SELECT * FROM reservations WHERE setup_token_id = ? AND status = 'PENDING'").get(setupId) as any;
  if (!reservation) return c.redirect('/?paypal=reservation-not-found');
  try {
    const outcome = await saveVault(reservation, setupId);
    return c.redirect(`/r/${reservation.id}?paypal=${outcome === 'RESERVED' ? 'reserved' : 'cancelled'}`);
  } catch (error) { return c.redirect(`/r/${reservation.id}?paypal=${encodeURIComponent(error instanceof Error ? error.message : 'failed')}`); }
});

const cardEntry = () => process.env.PAYPAL_ENV !== 'live';
const CardReserveInput = ReserveInput.extend({
  name: z.string().trim().min(2, 'Enter the name on the card.').max(300),
  number: z.string().regex(/^\d{12,19}$/, 'Enter the card number digits.'),
  expiry: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Enter the card expiry month.'),
  securityCode: z.string().regex(/^\d{3,4}$/, 'Enter the card security code.'),
});

// The card goes to PayPal once and is never stored or logged here; PayPal returns a vault token.
app.post('/api/campaigns/:slug/reservations/card', async c => {
  if (!cardEntry()) return c.json({ error: 'Card entry is available with PayPal sandbox credentials.' }, 404);
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) return c.json({ error: 'PayPal setup is required to reserve. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.' }, 503);
  const campaign = campaignBySlug(c.req.param('slug'));
  if (!campaign) return c.json({ error: 'Campaign not found.' }, 404);
  const parsed = CardReserveInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Card details are invalid.' }, 400);
  const { email, qty, name, number, expiry, securityCode } = parsed.data;
  if (campaignAvailability(campaign.id).reserved + qty > campaign.quantity) return c.json({ error: 'There are not enough units left for this reservation.' }, 409);
  const id = randomUUID();
  const setupRequestId = newRequestId();
  const position = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM reservations WHERE campaign_id = ?').get(campaign.id) as { next: number }).next;
  db.prepare(`INSERT INTO reservations (id, campaign_id, email, qty, position, status, setup_request_id, payment_kind, created_at)
    VALUES (?, ?, ?, ?, ?, 'PENDING', ?, 'card', ?)`).run(id, campaign.id, email.toLowerCase(), qty, position, setupRequestId, nowIso());
  try {
    const setup = await createCardSetupToken({ name, number, expiry, securityCode }, setupRequestId);
    db.prepare('UPDATE reservations SET setup_token_id = ? WHERE id = ?').run(setup.id, id);
    if (setup.status !== 'APPROVED') throw new Error(`PayPal returned card setup status ${setup.status}.`);
    const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
    const outcome = await saveVault(reservation, setup.id);
    return c.json({ reservationId: id, status: outcome, path: `/r/${id}?paypal=reserved` }, 201);
  } catch (error) {
    db.prepare("UPDATE reservations SET status = 'CANCELLED' WHERE id = ? AND status = 'PENDING' AND vault_id IS NULL").run(id);
    return errorResponse(c, error);
  }
});

app.post('/api/reservations/:id/cancel', async c => {
  const row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(c.req.param('id')) as any;
  if (!row) return c.json({ error: 'Reservation not found.' }, 404);
  if (!['PENDING', 'RESERVED'].includes(row.status)) return c.json({ error: 'This reservation can no longer be cancelled.' }, 409);
  if (row.status === 'PENDING' && !row.vault_id) {
    const cancelled = db.prepare("UPDATE reservations SET status = 'CANCELLED' WHERE id = ? AND status = 'PENDING'").run(row.id);
    if (Number(cancelled.changes) === 0) return c.json({ error: 'The reservation changed while it was being cancelled. Refresh and try again.' }, 409);
    const campaign = db.prepare('SELECT slug FROM campaigns WHERE id = ?').get(row.campaign_id) as { slug: string };
    emit('reservation', campaign.slug);
    return c.json({ status: 'CANCELLED' });
  }
  const locked = db.prepare("UPDATE reservations SET status = 'CANCEL_PENDING' WHERE id = ? AND status = 'RESERVED'").run(row.id);
  if (Number(locked.changes) === 0) return c.json({ error: 'The reservation changed while it was being cancelled. Refresh and try again.' }, 409);
  try {
    const requestId = row.cancel_request_id || newRequestId();
    db.prepare('UPDATE reservations SET cancel_request_id = ? WHERE id = ? AND cancel_request_id IS NULL').run(requestId, row.id);
    await deletePaymentToken(row.vault_id, requestId);
    if (await getPaymentTokenForCancelCheck(row.vault_id)) throw new Error('PayPal still returns the saved payment token after deletion.');
    db.prepare("UPDATE reservations SET status = 'CANCELLED' WHERE id = ? AND status = 'CANCEL_PENDING'").run(row.id);
    const campaign = db.prepare('SELECT slug FROM campaigns WHERE id = ?').get(row.campaign_id) as { slug: string };
    emit('reservation', campaign.slug);
    return c.json({ status: 'CANCELLED' });
  } catch (error) {
    db.prepare("UPDATE reservations SET status = 'RESERVED' WHERE id = ? AND status = 'CANCEL_PENDING'").run(row.id);
    return errorResponse(c, error);
  }
});

app.get('/api/reservations/:id', c => {
  const row = db.prepare(`SELECT r.id, r.qty, r.position, r.status, r.capture_id, r.paypal_issue, r.wave_id, w.ship_date,
    c.name AS campaign_name, c.image_url AS campaign_image_url, c.ship_date AS campaign_ship_date, c.charge_window_days, c.currency, c.price_cents
    FROM reservations r JOIN campaigns c ON c.id = r.campaign_id LEFT JOIN waves w ON w.id = r.wave_id WHERE r.id = ?`).get(c.req.param('id')) as any;
  if (!row) return c.json({ error: 'Reservation not found.' }, 404);
  const refund = db.prepare("SELECT refund_id, reason, completed_at FROM refunds WHERE reservation_id = ? AND status = 'COMPLETED' ORDER BY completed_at DESC LIMIT 1").get(row.id) as { refund_id: string; reason: string; completed_at: string } | undefined;
  return c.json({ refund: refund ? { refundId: refund.refund_id, reason: refund.reason, refundedAt: refund.completed_at } : null, id: row.id, qty: row.qty, position: row.position, status: row.status, captureId: row.capture_id, issue: row.paypal_issue, campaignName: row.campaign_name, imageUrl: row.campaign_image_url, shipDate: row.ship_date || row.campaign_ship_date, chargeWindowDays: row.charge_window_days, currency: row.currency, amountCents: row.price_cents * row.qty, canCancel: ['PENDING', 'RESERVED'].includes(row.status) });
});

app.get('/api/campaigns/:slug/desk', c => {
  const campaign = requireCampaign(c, c.req.param('slug'), true);
  if (!asCampaign(campaign)) return campaign;
  const waves = db.prepare('SELECT * FROM waves WHERE campaign_id = ? ORDER BY ship_date, number').all(campaign.id) as any[];
  const allocations = campaignAllocations(campaign.id);
  const reservations = db.prepare(`SELECT r.*, a.completed_at AS captured_at, w.ship_date AS wave_ship_date,
    (SELECT f.refund_id FROM refunds f WHERE f.reservation_id = r.id AND f.status = 'COMPLETED' ORDER BY f.completed_at DESC LIMIT 1) AS refund_id
    FROM reservations r LEFT JOIN charge_attempts a ON a.capture_id = r.capture_id AND a.status = 'COMPLETED' LEFT JOIN waves w ON w.id = r.wave_id
    WHERE r.campaign_id = ? ORDER BY r.position`).all(campaign.id) as any[];
  const updates = db.prepare('SELECT * FROM supply_updates WHERE campaign_id = ? ORDER BY event_date, confirmed_at').all(campaign.id) as any[];
  const { reserved } = campaignAvailability(campaign.id);
  return c.json({ campaign: { id: campaign.id, slug: campaign.slug, name: campaign.name, imageUrl: campaign.image_url, priceCents: campaign.price_cents, currency: campaign.currency, quantity: campaign.quantity, shipDate: campaign.ship_date, chargeWindowDays: campaign.charge_window_days }, reserved, available: Math.max(0, campaign.quantity - reserved), waves: waves.map(w => ({ id: w.id, number: w.number, units: w.units, shipDate: w.ship_date, dateOverride: w.date_override })), allocations, reservations: reservations.map(r => ({ id: r.id, email: r.email, qty: r.qty, position: r.position, status: r.status, waveId: r.wave_id, captureId: r.capture_id, orderId: r.paypal_order_id, issue: r.paypal_issue, trackingNumber: r.tracking_number, carrier: r.carrier, capturedAt: r.captured_at, refundId: r.refund_id,
    outsideWindow: r.status === 'CHARGED' && Boolean(r.captured_at && r.wave_ship_date) && outsideChargeWindow(r.captured_at, r.wave_ship_date, campaign.charge_window_days) })), updates: updates.map(u => ({ id: u.id, units: u.units, milestone: u.milestone, date: u.event_date, origin: u.origin, destination: u.destination, vesselOrCarrier: u.vessel_or_carrier, quotes: JSON.parse(u.quotes), confidence: u.confidence, confirmedAt: u.confirmed_at })), tasks: ganttTasks(waves.map(w => ({ id: w.id, number: w.number, units: w.units, shipDate: w.ship_date })), campaign.charge_window_days), dependencies: ganttDependencies(waves.map(w => ({ id: w.id, number: w.number, units: w.units, shipDate: w.ship_date }))) });
});

app.post('/api/campaigns/:slug/supply/extract', async c => {
  const campaign = requireCampaign(c, c.req.param('slug'), true);
  if (!asCampaign(campaign)) return campaign;
  const form = await c.req.formData();
  const text = String(form.get('text') || '').trim();
  const file = form.get('file');
  if (!text && !(file instanceof File && file.size)) return c.json({ error: 'Paste a supply email or choose a PDF or photo.' }, 400);
  let inputFile: { name: string; mime: string; bytes: Uint8Array } | undefined;
  if (file instanceof File && file.size) {
    if (file.size > 10 * 1024 * 1024) return c.json({ error: 'Supply files must be 10 MB or smaller.' }, 413);
    const mime = file.type.toLowerCase();
    if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(mime)) return c.json({ error: 'Upload a PDF, JPG, PNG, or WebP file.' }, 415);
    inputFile = { name: file.name, mime, bytes: new Uint8Array(await file.arrayBuffer()) };
  }
  try {
    const extraction = await extractSupply({ text, file: inputFile });
    return c.json({ extraction, source: text, sourceLabel: inputFile?.name || 'Pasted supplier email' });
  } catch (error) { return errorResponse(c, error); }
});

app.post('/api/campaigns/:slug/supply/confirm', async c => {
  const campaign = requireCampaign(c, c.req.param('slug'), true);
  if (!asCampaign(campaign)) return campaign;
  const parsed = ConfirmInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Confirmed supply fields are invalid.' }, 400);
  const input = parsed.data;
  if (input.source && input.quotes.some(q => !input.source.includes(q))) return c.json({ error: 'Every quote must appear exactly in the pasted source.' }, 400);
  const id = randomUUID();
  db.prepare(`INSERT INTO supply_updates (id, campaign_id, source, units, milestone, event_date, origin, destination, vessel_or_carrier, quotes, confidence, confirmed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, campaign.id, input.source || 'Uploaded document', input.units, input.milestone, input.date, input.origin, input.destination, input.vesselOrCarrier, JSON.stringify(input.quotes), input.confidence, nowIso());
  const plan = rebuildPlan(campaign);
  let explanation: string | null = null;
  try { explanation = await explainPlan({ update: input, waves: plan.waves, allocations: plan.allocations }); } catch { /* the confirmed plan remains available without generated wording */ }
  emit('supply', campaign.slug);
  return c.json({ updateId: id, ...plan, explanation }, 201);
});

app.post('/api/campaigns/:slug/waves/:waveId/date', async c => {
  const campaign = requireCampaign(c, c.req.param('slug'), true);
  if (!asCampaign(campaign)) return campaign;
  const parsed = MoveInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Ship date must use YYYY-MM-DD.' }, 400);
  const existing = db.prepare('SELECT id, number, units, ship_date FROM waves WHERE id = ? AND campaign_id = ?').get(c.req.param('waveId'), campaign.id) as any;
  if (!existing) return c.json({ error: 'Wave not found.' }, 404);
  moveWave([{ id: existing.id, number: existing.number, units: existing.units, shipDate: existing.ship_date }], existing.id, parsed.data.shipDate);
  db.prepare('UPDATE waves SET ship_date = ?, date_override = ? WHERE id = ?').run(parsed.data.shipDate, parsed.data.shipDate, existing.id);
  const plan = refreshWaveData(campaign);
  emit('schedule', campaign.slug);
  return c.json(plan);
});

app.post('/api/campaigns/:slug/waves/:waveId/charge', async c => {
  const campaign = requireCampaign(c, c.req.param('slug'), true);
  if (!asCampaign(campaign)) return campaign;
  const wave = db.prepare('SELECT * FROM waves WHERE id = ? AND campaign_id = ?').get(c.req.param('waveId'), campaign.id) as any;
  if (!wave) return c.json({ error: 'Wave not found.' }, 404);
  if (!isChargeEligible(wave.ship_date, new Date(), campaign.charge_window_days)) {
    return c.json({ error: `This wave can be charged from ${new Date(Date.parse(`${wave.ship_date}T00:00:00Z`) - campaign.charge_window_days * 86_400_000).toISOString().slice(0, 10)} through ${wave.ship_date}.`, eligible: false }, 409);
  }
  const reservations = db.prepare(`SELECT * FROM reservations WHERE campaign_id = ? AND wave_id = ? AND status IN ('RESERVED','DECLINED','CHARGE_PENDING','CHARGED','SHIPPED') ORDER BY position`).all(campaign.id, wave.id) as any[];
  const results = [];
  for (const reservation of reservations) results.push(await chargeReservation(campaign, reservation));
  emit('charge', campaign.slug);
  return c.json({ eligible: true, results });
});

app.post('/api/campaigns/:slug/waves/:waveId/refund', async c => {
  const campaign = requireCampaign(c, c.req.param('slug'), true);
  if (!asCampaign(campaign)) return campaign;
  const wave = db.prepare('SELECT * FROM waves WHERE id = ? AND campaign_id = ?').get(c.req.param('waveId'), campaign.id) as any;
  if (!wave) return c.json({ error: 'Wave not found.' }, 404);
  const rows = db.prepare(`SELECT r.id, r.capture_id, a.id AS attempt_id, a.completed_at FROM reservations r
    JOIN charge_attempts a ON a.capture_id = r.capture_id AND a.status = 'COMPLETED'
    WHERE r.campaign_id = ? AND r.wave_id = ? AND r.status = 'CHARGED' ORDER BY r.position`).all(campaign.id, wave.id) as { id: string; capture_id: string; attempt_id: string; completed_at: string }[];
  const late = rows.filter(row => outsideChargeWindow(row.completed_at, wave.ship_date, campaign.charge_window_days));
  if (!late.length) return c.json({ error: 'No charged reservation in this wave ships outside its charge window.' }, 409);
  const results = [];
  for (const row of late) {
    const reason = `Ship date moved to ${wave.ship_date}, more than ${campaign.charge_window_days} days after the ${row.completed_at.slice(0, 10)} charge.`;
    results.push(await refundCharge(row.id, row.attempt_id, row.capture_id, reason));
  }
  refreshWaveData(campaign);
  emit('refund', campaign.slug);
  return c.json({ results });
});

app.post('/api/campaigns/:slug/waves/:waveId/tracking/read', async c => {
  const campaign = requireCampaign(c, c.req.param('slug'), true);
  if (!asCampaign(campaign)) return campaign;
  const parsed = z.object({ text: z.string().trim().min(10).max(100_000) }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Paste the carrier or warehouse dispatch confirmation.' }, 400);
  const rows = db.prepare("SELECT id, position, email FROM reservations WHERE campaign_id = ? AND wave_id = ? AND status = 'CHARGED' AND tracking_number IS NULL ORDER BY position").all(campaign.id, c.req.param('waveId')) as { id: string; position: number; email: string }[];
  if (!rows.length) return c.json({ error: 'No charged reservation in this wave is waiting for tracking.' }, 409);
  try {
    const { shipments } = await extractShipments(parsed.data.text);
    return c.json(matchShipments(shipments, rows));
  } catch (error) { return errorResponse(c, error); }
});

app.post('/api/campaigns/:slug/waves/:waveId/tracking', async c => {
  const campaign = requireCampaign(c, c.req.param('slug'), true);
  if (!asCampaign(campaign)) return campaign;
  const parsed = TrackingInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Tracking details are invalid.' }, 400);
  const results = [];
  for (const item of parsed.data.items) {
    const row = db.prepare("SELECT * FROM reservations WHERE id = ? AND campaign_id = ? AND status IN ('CHARGED','SHIPPED')").get(item.reservationId, campaign.id) as any;
    if (!row?.paypal_order_id || !row.capture_id || !row.wave_id) { results.push({ id: item.reservationId, error: 'A completed capture is required before tracking can be added.' }); continue; }
    if (row.status === 'SHIPPED') { results.push({ id: row.id, status: 'SHIPPED', trackingNumber: row.tracking_number }); continue; }
    if (db.prepare("SELECT 1 FROM refunds WHERE reservation_id = ? AND status = 'PENDING'").get(row.id)) { results.push({ id: row.id, error: 'A refund is in progress for this charge.' }); continue; }
    try {
      const requestId = row.tracking_request_id || newRequestId();
      db.prepare('UPDATE reservations SET tracking_request_id = ?, tracking_number = ?, carrier = ? WHERE id = ? AND tracking_request_id IS NULL').run(requestId, item.trackingNumber, item.carrier, row.id);
      await addTracking({ orderId: row.paypal_order_id, captureId: row.capture_id, trackingNumber: item.trackingNumber, carrier: item.carrier }, requestId);
      const order = await getOrder(row.paypal_order_id);
      if (!orderHasTracker(order, row.capture_id, item.trackingNumber)) throw new Error('PayPal order readback did not contain the tracking number.');
      db.prepare("UPDATE reservations SET status = 'SHIPPED' WHERE id = ?").run(row.id);
      results.push({ id: row.id, status: 'SHIPPED', trackingNumber: item.trackingNumber });
    } catch (error) { results.push({ id: row.id, error: error instanceof Error ? error.message : 'Tracking update failed.' }); }
  }
  emit('tracking', campaign.slug);
  return c.json({ results });
});

app.post('/api/paypal/webhook', async c => {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return c.json({ error: 'PAYPAL_WEBHOOK_ID is not configured.' }, 503);
  const body = await c.req.json();
  const headers = c.req.header();
  try {
    const result = await verifyWebhook({
      auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'], webhook_id: webhookId, webhook_event: body,
    });
    if (result.verification_status !== 'SUCCESS') return c.json({ error: 'PayPal webhook signature was not verified.' }, 401);
    void reconcilePending();
    return c.json({ received: true });
  } catch (error) { return errorResponse(c, error); }
});

app.onError((error, c) => errorResponse(c, error));

const mimeTypes: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
app.get('/assets/*', async c => {
  const path = resolve('web/dist', c.req.path.replace(/^\//, ''));
  if (!path.startsWith(resolve('web/dist/assets'))) return c.text('Not found', 404);
  try {
    const data = await readFile(path);
    const ext = path.slice(path.lastIndexOf('.'));
    return new Response(data, { headers: { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  } catch { return c.text('Not found', 404); }
});
app.get('*', async c => {
  try { return c.html(await readFile(resolve('web/dist/index.html'), 'utf8')); }
  catch { return c.text('Shipday frontend is not built. Run npm run build.', 503); }
});

function rebuildPlan(campaign: CampaignRow) {
  const supplies = db.prepare('SELECT id, units, milestone, event_date FROM supply_updates WHERE campaign_id = ? ORDER BY event_date, confirmed_at').all(campaign.id) as { id: string; units: number; milestone: Milestone; event_date: string }[];
  const reservations = plannedReservations(campaign.id);
  const prior = new Map((db.prepare('SELECT id, date_override FROM waves WHERE campaign_id = ?').all(campaign.id) as { id: string; date_override: string | null }[]).map(w => [w.id, w.date_override]));
  const plan = planWaves(supplies.map(s => ({ id: s.id, units: s.units, milestone: s.milestone, eventDate: s.event_date })), reservations);
  return persistPlan(campaign, plan, prior);
}

function refreshWaveData(campaign: CampaignRow) {
  const waves = db.prepare('SELECT * FROM waves WHERE campaign_id = ? ORDER BY number').all(campaign.id) as any[];
  const supplies = db.prepare('SELECT id, units, milestone, event_date FROM supply_updates WHERE campaign_id = ? ORDER BY event_date, confirmed_at').all(campaign.id) as { id: string; units: number; milestone: Milestone; event_date: string }[];
  const reservations = plannedReservations(campaign.id);
  const plan = planWaves(supplies.map(s => ({ id: s.id, units: s.units, milestone: s.milestone, eventDate: s.event_date })), reservations);
  return persistPlan(campaign, plan, new Map(waves.map(w => [w.id, w.date_override || w.ship_date])));
}

function plannedReservations(campaignId: string) {
  const rows = db.prepare(`SELECT r.id, r.qty, r.position, r.status, r.capture_id, r.wave_id, a.wave_id AS allocation_wave_id, a.qty AS allocation_qty
    FROM reservations r LEFT JOIN reservation_allocations a ON a.reservation_id = r.id
    WHERE r.campaign_id = ? AND r.status IN ('RESERVED','DECLINED','CHARGE_PENDING','CHARGED','SHIPPED')
    ORDER BY r.position, a.wave_id`).all(campaignId) as { id: string; qty: number; position: number; status: string; capture_id: string | null; wave_id: string | null; allocation_wave_id: string | null; allocation_qty: number | null }[];
  return [...new Map(rows.map(row => [row.id, {
    id: row.id, qty: row.qty, position: row.position, status: row.status, captureId: row.capture_id, waveId: row.wave_id,
    allocations: rows.filter(allocation => allocation.id === row.id && allocation.allocation_wave_id)
      .map(allocation => ({ reservationId: row.id, waveId: allocation.allocation_wave_id!, qty: allocation.allocation_qty! })),
  }])).values()];
}

function persistPlan(campaign: CampaignRow, plan: ReturnType<typeof planWaves>, overrides: Map<string, string | null>) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM waves WHERE campaign_id = ?').run(campaign.id);
    db.prepare("UPDATE reservations SET wave_id = NULL WHERE campaign_id = ? AND capture_id IS NULL AND status NOT IN ('CHARGE_PENDING','CHARGED','SHIPPED')").run(campaign.id);
    for (const wave of plan.waves) {
      const date = overrides.get(wave.id) || wave.shipDate;
      db.prepare('INSERT INTO waves (id, campaign_id, number, units, ship_date, date_override) VALUES (?, ?, ?, ?, ?, ?)')
        .run(wave.id, campaign.id, wave.number, wave.units, date, overrides.get(wave.id) || null);
    }
    for (const allocation of plan.allocations) db.prepare('INSERT INTO reservation_allocations (reservation_id, wave_id, qty) VALUES (?, ?, ?)').run(allocation.reservationId, allocation.waveId, allocation.qty);
    for (const reservation of plan.allocations.map(a => a.reservationId).filter((id, i, all) => all.indexOf(id) === i)) {
      const latest = plan.allocations.filter(a => a.reservationId === reservation).at(-1)?.waveId;
      if (latest) db.prepare("UPDATE reservations SET wave_id = ? WHERE id = ? AND capture_id IS NULL AND status NOT IN ('CHARGE_PENDING','CHARGED','SHIPPED')").run(latest, reservation);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const waves = db.prepare('SELECT * FROM waves WHERE campaign_id = ? ORDER BY number').all(campaign.id) as any[];
  const allocations = campaignAllocations(campaign.id);
  return { waves: waves.map(w => ({ id: w.id, number: w.number, units: w.units, shipDate: w.ship_date })), allocations };
}

async function chargeReservation(campaign: CampaignRow, reservation: any) {
  const refusal = chargeRefusal(reservation.status, Boolean(reservation.capture_id || hasLiveCapture(reservation.id)));
  if (refusal) return { id: reservation.id, status: reservation.status, error: refusal };
  let attempt = db.prepare("SELECT * FROM charge_attempts WHERE reservation_id = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1").get(reservation.id) as any;
  if (!attempt) {
    const id = randomUUID();
    const requestId = newRequestId();
    const captureRequestId = newRequestId();
    db.prepare(`INSERT INTO charge_attempts (id, reservation_id, paypal_request_id, capture_request_id, status, created_at)
      VALUES (?, ?, ?, ?, 'PENDING', ?)`)
      .run(id, reservation.id, requestId, captureRequestId, nowIso());
    db.prepare("UPDATE reservations SET status = 'CHARGE_PENDING', paypal_issue = NULL WHERE id = ?").run(reservation.id);
    attempt = { id, reservation_id: reservation.id, paypal_request_id: requestId, capture_request_id: captureRequestId, status: 'PENDING' };
  }
  try {
    if (!attempt.paypal_order_id) {
      const created = await createVaultOrder({ vaultId: reservation.vault_id, kind: reservation.payment_kind, amount: (campaign.price_cents * reservation.qty / 100).toFixed(2), currency: campaign.currency, reservationId: reservation.id }, attempt.paypal_request_id);
      db.prepare('UPDATE charge_attempts SET paypal_order_id = ? WHERE id = ?').run(created.id, attempt.id);
      db.prepare('UPDATE reservations SET paypal_order_id = ? WHERE id = ?').run(created.id, reservation.id);
      attempt.paypal_order_id = created.id;
    }
    let order = await getOrder(attempt.paypal_order_id);
    let capture = order.purchase_units?.flatMap(unit => unit.payments?.captures || []).find(c => c.status === 'COMPLETED');
    if (!capture && order.status !== 'COMPLETED') {
      const captureResult = await captureOrder(order.id, attempt.capture_request_id);
      const responseCapture = captureResult.purchase_units?.flatMap(unit => unit.payments?.captures || []).find(x => x.id);
      if (responseCapture?.id && !captureResult.purchase_units?.flatMap(unit => unit.payments?.captures || []).some(x => x.status === 'COMPLETED')) {
        db.prepare('UPDATE charge_attempts SET capture_id = ? WHERE id = ?').run(responseCapture.id, attempt.id);
      }
    }
    for (let i = 0; i < 8; i++) {
      order = await getOrder(attempt.paypal_order_id);
      capture = order.purchase_units?.flatMap(unit => unit.payments?.captures || []).find(x => x.status === 'COMPLETED');
      if (capture) break;
      const failed = order.purchase_units?.flatMap(unit => unit.payments?.captures || []).find(x => ['DECLINED', 'FAILED', 'DENIED'].includes(x.status));
      if (failed) return markDeclined(attempt, reservation, failed.status_details?.reason || failed.status);
      await new Promise(resolve => setTimeout(resolve, Math.min(500 * 2 ** i, 4000)));
    }
    if (!capture || order.status !== 'COMPLETED') return { id: reservation.id, status: 'CHARGE_PENDING', orderId: order.id, error: 'PayPal has not returned a completed capture yet. Shipday will keep checking.' };
    db.prepare("UPDATE charge_attempts SET status = 'COMPLETED', capture_id = ?, completed_at = ? WHERE id = ?").run(capture.id, nowIso(), attempt.id);
    db.prepare("UPDATE reservations SET status = 'CHARGED', capture_id = ?, paypal_issue = NULL WHERE id = ?").run(capture.id, reservation.id);
    return { id: reservation.id, status: 'CHARGED', orderId: order.id, captureId: capture.id };
  } catch (error) {
    if (error instanceof PayPalError && [400, 403, 422].includes(error.status)) return markDeclined(attempt, reservation, error.issue || error.message);
    return { id: reservation.id, status: 'CHARGE_PENDING', error: error instanceof Error ? error.message : 'PayPal charge is still being reconciled.' };
  }
}

async function refundCharge(reservationId: string, attemptId: string, captureId: string, reason: string) {
  let refund = db.prepare('SELECT * FROM refunds WHERE charge_attempt_id = ?').get(attemptId) as any;
  if (!refund) {
    refund = { id: randomUUID(), paypal_request_id: newRequestId(), refund_id: null, status: 'PENDING' };
    db.prepare(`INSERT INTO refunds (id, reservation_id, charge_attempt_id, capture_id, paypal_request_id, status, reason, created_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`).run(refund.id, reservationId, attemptId, captureId, refund.paypal_request_id, reason, nowIso());
  }
  if (refund.status !== 'PENDING') return { id: reservationId, status: refund.status === 'COMPLETED' ? 'REFUNDED' : 'REFUND_FAILED', refundId: refund.refund_id, issue: refund.issue };
  try {
    if (!refund.refund_id) {
      const created = await refundCapture(captureId, refund.paypal_request_id);
      db.prepare('UPDATE refunds SET refund_id = ? WHERE id = ?').run(created.id, refund.id);
      refund.refund_id = created.id;
    }
    for (let i = 0; i < 6; i++) {
      const read = await getRefund(refund.refund_id);
      if (read.status === 'COMPLETED') {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare("UPDATE refunds SET status = 'COMPLETED', completed_at = ? WHERE id = ?").run(nowIso(), refund.id);
          db.prepare(`UPDATE reservations SET status = 'RESERVED', capture_id = NULL, paypal_order_id = NULL, paypal_issue = NULL,
            tracking_request_id = NULL, tracking_number = NULL, carrier = NULL WHERE id = ? AND status = 'CHARGED'`).run(reservationId);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return { id: reservationId, status: 'REFUNDED', refundId: read.id };
      }
      if (['FAILED', 'CANCELLED'].includes(read.status)) {
        db.prepare("UPDATE refunds SET status = 'FAILED', issue = ? WHERE id = ?").run(read.status_details?.reason || read.status, refund.id);
        return { id: reservationId, status: 'REFUND_FAILED', refundId: read.id, issue: read.status_details?.reason || read.status };
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(500 * 2 ** i, 4000)));
    }
    return { id: reservationId, status: 'REFUND_PENDING', refundId: refund.refund_id, error: 'PayPal has not completed the refund yet. Shipday will keep checking.' };
  } catch (error) {
    if (error instanceof PayPalError && [400, 403, 404, 422].includes(error.status)) {
      db.prepare("UPDATE refunds SET status = 'FAILED', issue = ? WHERE id = ?").run(error.issue || error.message, refund.id);
      return { id: reservationId, status: 'REFUND_FAILED', issue: error.issue || error.message };
    }
    return { id: reservationId, status: 'REFUND_PENDING', error: error instanceof Error ? error.message : 'PayPal refund is still being reconciled.' };
  }
}

function markDeclined(attempt: any, reservation: any, issue: string) {
  db.prepare("UPDATE charge_attempts SET status = 'DECLINED', issue = ? WHERE id = ?").run(issue, attempt.id);
  db.prepare("UPDATE reservations SET status = 'DECLINED', paypal_issue = ? WHERE id = ? AND status != 'CHARGED'").run(issue, reservation.id);
  return { id: reservation.id, status: 'DECLINED', issue };
}

async function reconcilePending() {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) return;
  const attempts = db.prepare(`SELECT a.*, r.campaign_id, r.id AS reservation_id, r.vault_id, r.payment_kind, r.qty, c.price_cents, c.currency, c.slug
    FROM charge_attempts a JOIN reservations r ON r.id = a.reservation_id JOIN campaigns c ON c.id = r.campaign_id
    WHERE a.status = 'PENDING'`).all() as any[];
  for (const attempt of attempts) {
    try {
      if (!attempt.paypal_order_id) {
        const created = await createVaultOrder({ vaultId: attempt.vault_id, kind: attempt.payment_kind, amount: (attempt.price_cents * attempt.qty / 100).toFixed(2), currency: attempt.currency, reservationId: attempt.reservation_id }, attempt.paypal_request_id);
        db.prepare('UPDATE charge_attempts SET paypal_order_id = ? WHERE id = ?').run(created.id, attempt.id);
        db.prepare('UPDATE reservations SET paypal_order_id = ? WHERE id = ?').run(created.id, attempt.reservation_id);
        attempt.paypal_order_id = created.id;
      }
      const order = await getOrder(attempt.paypal_order_id);
      const capture = order.purchase_units?.flatMap(unit => unit.payments?.captures || []).find(x => x.status === 'COMPLETED');
      if (capture && order.status === 'COMPLETED') {
        db.prepare("UPDATE charge_attempts SET status = 'COMPLETED', capture_id = ?, completed_at = ? WHERE id = ?").run(capture.id, nowIso(), attempt.id);
        db.prepare("UPDATE reservations SET status = 'CHARGED', capture_id = ?, paypal_issue = NULL WHERE id = ? AND status != 'SHIPPED'").run(capture.id, attempt.reservation_id);
        emit('charge', attempt.slug);
      }
    } catch (error) { console.error('Shipday charge reconciliation failed', { name: error instanceof Error ? error.name : 'Error' }); }
  }
  const refunds = db.prepare(`SELECT f.*, c.id AS campaign_id FROM refunds f JOIN reservations r ON r.id = f.reservation_id JOIN campaigns c ON c.id = r.campaign_id WHERE f.status = 'PENDING'`).all() as any[];
  for (const refund of refunds) {
    const result = await refundCharge(refund.reservation_id, refund.charge_attempt_id, refund.capture_id, refund.reason);
    if (result.status === 'REFUNDED') {
      const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(refund.campaign_id) as CampaignRow;
      refreshWaveData(campaign);
      emit('refund', campaign.slug);
    }
  }
}

async function verifyWebhook(input: Record<string, unknown>) {
  return verifyWebhookSignature(input);
}

function errorResponse(c: any, error: unknown) {
  if (error instanceof AIError) return c.json({ error: error.message }, error.status && error.status < 500 ? error.status : 502);
  if (error instanceof PayPalError) return c.json({ error: error.message, issue: error.issue, debugId: error.debugId }, error.status >= 400 && error.status < 500 ? 502 : 502);
  const message = error instanceof Error ? error.message : 'Request failed.';
  return c.json({ error: message }, 400);
}

setInterval(() => { void reconcilePending(); }, 15_000).unref();
const port = Number(process.env.PORT || 8787);
serve({ fetch: app.fetch, port }, info => console.log(`Shipday listening on ${info.port}`));
