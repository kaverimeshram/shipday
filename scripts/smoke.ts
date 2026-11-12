import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { db } from '../src/db.js';
import { getOrder, getPaymentToken } from '../src/paypal.js';

type Session = { baseUrl: string; slug: string; reservationId: string; setupTokenId: string; setupStatus: string; approvalUrl: string; merchantCookie: string };
const statePath = resolve('.progress/smoke-session.json');
const resumeId = process.argv.indexOf('--resume') >= 0 ? process.argv[process.argv.indexOf('--resume') + 1] : undefined;
const missing = [
  ...(!process.env.PAYPAL_CLIENT_ID ? ['PAYPAL_CLIENT_ID'] : []),
  ...(!process.env.PAYPAL_CLIENT_SECRET ? ['PAYPAL_CLIENT_SECRET'] : []),
  ...(!process.env.OPENROUTER_API_KEY ? ['OPENROUTER_API_KEY'] : []),
  ...(!process.env.DEMO_BUYER_EMAIL ? ['DEMO_BUYER_EMAIL'] : []),
  ...(!process.env.SMOKE_SUPPLY_FILE ? ['SMOKE_SUPPLY_FILE'] : []),
];

if (process.env.PAYPAL_ENV === 'live') {
  console.error('Smoke is sandbox-only. Set PAYPAL_ENV=sandbox.');
  process.exit(2);
}
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(2);
}
if (process.argv.includes('--resume') && !resumeId) {
  console.error('Usage: npm run smoke -- --resume <setupTokenId>');
  process.exit(2);
}

const baseUrl = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '8787'}`).replace(/\/$/, '');
const local = new URL(baseUrl).hostname === 'localhost' || new URL(baseUrl).hostname === '127.0.0.1';
let child: ChildProcess | undefined;
let session: Session | undefined;

async function main() {
  if (local) {
    child = await ensureServer();
    await waitForHealth(baseUrl, 30_000);
  }
  if (!resumeId) {
    if (!local) throw new Error('A new smoke run must use a local Shipday server so its private merchant session can be persisted safely.');
    session = await createCampaignAndSetup(baseUrl);
    await saveSession(session);
    console.log(`PayPal setup token: ${session.setupTokenId} (${session.setupStatus})`);
    console.log(`Approval URL: ${session.approvalUrl}`);
    console.log('Approve with a PayPal sandbox buyer in the browser. This run waits up to 10 minutes.');
  } else {
    session = JSON.parse(await readFile(statePath, 'utf8')) as Session;
    if (session.setupTokenId !== resumeId) throw new Error('The setup token does not match the saved local smoke session.');
  }
  const current = session!;
  await waitForReservation(current, resumeId ? 30_000 : 10 * 60_000);
  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(current.reservationId) as any;
  if (reservation.status !== 'RESERVED' || !reservation.vault_id) throw new Error(`Reservation did not become RESERVED. Observed ${reservation.status}.`);
  const token = await getPaymentToken(reservation.vault_id);
  if (token.id !== reservation.vault_id) throw new Error('PayPal payment token GET readback did not match the saved token.');
  console.log(`PayPal payment token GET: ${token.id} (readback confirmed)`);

  const source = await readFile(resolve(process.env.SMOKE_SUPPLY_FILE!), 'utf8');
  const form = new FormData(); form.set('text', source);
  const extracted = await request<{ extraction: any; source: string }>(`${current.baseUrl}/api/campaigns/${current.slug}/supply/extract`, { method: 'POST', body: form, headers: { Cookie: current.merchantCookie } });
  const data = extracted.extraction;
  const eventDate = data.date || isoDate(data.eta);
  if (!data.units || !eventDate) throw new Error('The supply source needs a supported unit count and a date written as YYYY-MM-DD.');
  console.log(`Supply extraction for review: ${data.units} units, ${data.milestone}, ${eventDate}, confidence ${data.confidence}.`);
  for (const quote of data.quotes) console.log(`Source: ${quote}`);
  if (!stdin.isTTY) throw new Error('A terminal is required so a merchant can confirm the extracted supplier facts.');
  const prompt = createInterface({ input: stdin, output: stdout });
  const confirmed = (await prompt.question('Confirm these fields match the supplier source? Type yes: ')).trim().toLowerCase() === 'yes';
  prompt.close();
  if (!confirmed) throw new Error('Supply update was not confirmed. No charge was attempted.');
  await request(`${current.baseUrl}/api/campaigns/${current.slug}/supply/confirm`, {
    method: 'POST', headers: { Cookie: current.merchantCookie },
    body: JSON.stringify({ source: extracted.source, units: data.units, milestone: data.milestone, date: eventDate, origin: data.origin, destination: data.destination, vesselOrCarrier: data.vessel_or_carrier, quotes: data.quotes, confidence: data.confidence }),
  });
  const desk = await request<any>(`${current.baseUrl}/api/campaigns/${current.slug}/desk`, { headers: { Cookie: current.merchantCookie } });
  const allocation = desk.allocations.find((item: any) => item.reservationId === current.reservationId);
  if (!allocation) throw new Error('Confirmed supply did not allocate a unit to the smoke reservation.');
  const wave = desk.waves.find((item: any) => item.id === allocation.waveId);
  if (!wave) throw new Error('Planner did not return the reservation wave.');
  console.log(`Planned wave ${wave.number}: ${wave.units} units, expected ship ${wave.shipDate}.`);

  const charged = await request<{ results: { id: string; status: string; captureId?: string; error?: string; issue?: string }[] }>(`${current.baseUrl}/api/campaigns/${current.slug}/waves/${wave.id}/charge`, { method: 'POST', headers: { Cookie: current.merchantCookie }, body: '{}' });
  const result = charged.results.find(row => row.id === current.reservationId);
  if (result?.status !== 'CHARGED' || !result.captureId) throw new Error(`PayPal capture did not complete. Observed ${result?.status || 'no reservation result'}: ${result?.error || result?.issue || ''}`);
  const saved = db.prepare('SELECT paypal_order_id FROM reservations WHERE id = ?').get(current.reservationId) as { paypal_order_id: string };
  const order = await getOrder(saved.paypal_order_id);
  const capture = order.purchase_units?.flatMap(unit => unit.payments?.captures || []).find(item => item.id === result.captureId);
  if (order.status !== 'COMPLETED' || capture?.status !== 'COMPLETED') throw new Error(`PayPal readback is not terminal: order ${order.status}, capture ${capture?.status || 'missing'}.`);
  console.log(`PayPal order: ${order.id} (${order.status})`);
  console.log(`PayPal capture: ${capture.id} (${capture.status})`);

  const duplicate = await request<{ results: { id: string; status: string; error?: string }[] }>(`${current.baseUrl}/api/campaigns/${current.slug}/waves/${wave.id}/charge`, { method: 'POST', headers: { Cookie: current.merchantCookie }, body: '{}' });
  const refused = duplicate.results.find(row => row.id === current.reservationId);
  if (!refused?.error?.includes('already been charged')) throw new Error('A second charge request was not refused locally.');
  console.log(`Second charge attempt: refused locally (${refused.error})`);
  await unlink(statePath).catch(() => {});
}

async function ensureServer(): Promise<ChildProcess | undefined> {
  try { await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) }); return undefined; }
  catch {
    const port = process.env.PORT || '8787';
    const proc = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', 'src/index.ts'], {
      cwd: process.cwd(), env: { ...process.env, PORT: port }, stdio: 'ignore', detached: false,
    });
    proc.unref();
    return proc;
  }
}

async function waitForHealth(url: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) }); if (response.ok) return; }
    catch { await delay(500); }
  }
  throw new Error('Shipday server did not become healthy before the timeout.');
}

async function createCampaignAndSetup(url: string): Promise<Session> {
  const campaign = await request<{ slug: string }>(`${url}/api/campaigns`, {
    method: 'POST', body: JSON.stringify({ name: `Shipday sandbox smoke ${new Date().toISOString().slice(0, 10)}`, priceCents: 100, currency: 'USD', quantity: 1, shipDate: new Date().toISOString().slice(0, 10), chargeWindowDays: 365 }),
  }, true);
  const created = await lastResponse;
  const cookie = created.headers.getSetCookie()[0]?.split(';')[0];
  if (!cookie) throw new Error('Campaign creation did not return the merchant session cookie.');
  const setup = await request<{ reservationId: string; setupTokenId: string; setupStatus: string; approvalUrl: string }>(`${url}/api/campaigns/${campaign.slug}/reservations`, {
    method: 'POST', body: JSON.stringify({ email: process.env.DEMO_BUYER_EMAIL, qty: 1 }),
  });
  return { baseUrl: url, slug: campaign.slug, reservationId: setup.reservationId, setupTokenId: setup.setupTokenId, setupStatus: setup.setupStatus, approvalUrl: setup.approvalUrl, merchantCookie: cookie };
}

let lastResponse: Response;
async function request<T = unknown>(url: string, init?: RequestInit, retainResponse = false): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(!(init?.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init?.headers }, signal: AbortSignal.timeout(60_000) });
  if (retainResponse) lastResponse = response;
  const body = await response.json().catch(() => ({})) as T & { error?: string; issue?: string };
  if (!response.ok) throw new Error(body.error ? `${body.error}${body.issue ? ` (${body.issue})` : ''}` : `Request failed (${response.status}).`);
  return body;
}

async function waitForReservation(current: Session, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await request<{ status: string }>(`${current.baseUrl}/api/reservations/${current.reservationId}`);
    if (result.status === 'RESERVED') return;
    if (result.status === 'CANCELLED') throw new Error('The buyer cancelled this reservation.');
    await delay(1500);
  }
  throw new Error('Buyer approval did not complete within the timeout. Resume with the setup token after approval.');
}

async function saveSession(value: Session) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(value), { mode: 0o600 });
}

function isoDate(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return match?.[1] || null;
}

function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

main().catch(error => { console.error(error instanceof Error ? error.message : 'Smoke failed.'); process.exitCode = 1; })
  .finally(() => { if (child && !child.killed) child.kill('SIGTERM'); db.close(); });
