import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@bryntum/gantt/stockholm-light.css';
import './style.css';
import { chargeWindow, localIsoDate } from './dates';
import { GanttPanel } from './gantt-panel';


type Config = { missing: string[]; bryntumLicense: string | null; cardEntry?: boolean; demoSlug?: string | null };
type Campaign = { id: string; slug: string; name: string; description?: string | null; imageUrl: string | null; priceCents: number; currency: string; quantity: number; available?: number; reserved?: number; shipDate: string; chargeWindowDays: number; autoProtect?: boolean };
type Wave = { id: string; number: number; units: number; shipDate: string; dateOverride?: string | null };
type Reservation = { id: string; email?: string; qty: number; position: number; status: string; waveId?: string | null; captureId?: string | null; orderId?: string | null; issue?: string | null; trackingNumber?: string | null; carrier?: string | null; capturedAt?: string | null; refundId?: string | null; outsideWindow?: boolean; refundAutomatic?: boolean; refundedAt?: string | null; refundState?: 'PENDING' | 'FAILED' | null; refundIssue?: string | null; refundAttempts?: number | null; refundNextAttemptAt?: string | null };
type LedgerEntry = { id: string; kind: 'AUTO_REFUND' | 'AUTO_REFUND_FAILED' | 'REFUND' | 'REFUND_FAILED'; actor: string; reservationId: string; position: number | null; waveNumber: number | null; captureId: string | null; amountCents: number | null; currency: string | null; oldShipDate: string | null; newShipDate: string | null; windowDays: number | null; chargedAt: string | null; reason: string; refundId: string | null; paypalStatus: string | null; issue: string | null; attempt: number; at: string };
type SupplyUpdate = { id: string; units: number; milestone: string; date: string; origin: string | null; destination: string | null; vesselOrCarrier: string | null; quotes: string[]; confidence: number; confirmedAt: string };
type Hold = { id: string; waveId: string; previousShipDate: string; newShipDate: string; refundCount: number; refundCents: number; holdUntil: string };
type Desk = { campaign: Campaign; ledger?: LedgerEntry[]; holds?: Hold[]; graceSeconds?: number; reserved: number; available: number; waves: Wave[]; allocations: { reservationId: string; waveId: string; qty: number }[]; reservations: Reservation[]; updates: SupplyUpdate[]; tasks: Task[]; dependencies: { fromTask: string; toTask: string }[] };
type Task = { id: string; name: string; expanded?: boolean; children?: Task[]; startDate?: string; endDate?: string; eventColor?: string; percentDone?: number };
type Extraction = { units: number | null; milestone: string; date: string | null; eta: string | null; origin: string | null; destination: string | null; vessel_or_carrier: string | null; quotes: string[]; field_quotes: Record<string, string | null>; confidence: number };
type CampaignPublic = Campaign & { policy: { quote: string; context: string; url: string; checkedAt: string } };
type CampaignIndexItem = Campaign & { reserved: number; available: number };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function dateLabel(value: string, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en', options || { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

const DAY_MS = 86_400_000;
function shortDate(value: string): string { return dateLabel(value, { day: 'numeric', month: 'short', timeZone: 'UTC' }); }
function isoDaysBetween(from: string, to: string): number { return Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / DAY_MS); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!); }
const barColors = { production: '#8da4ad', freight: '#557789', warehouse: '#a9bcc5', open: '#e8590c', waiting: '#7f98a6', closed: '#a3a9ac', late: '#c62f1f', ship: '#3c6b42' };
type WaveState = { kind: 'late' | 'protect' | 'open' | 'done' | 'closed' | 'wait'; label: string };
type Replan = { wave: number; from: string; to: string; opensFrom: string; opensTo: string; eligibleBefore: boolean; eligibleAfter: boolean; closedAfter: boolean; refundDue: number; refundDueBefore: number; refundCents: number; chargeable: number; chargeableCents: number };

function waveFigures(desk: Desk, wave: Wave) {
  const rows = desk.reservations.filter(r => r.waveId === wave.id);
  const price = desk.campaign.priceCents;
  const late = rows.filter(r => r.outsideWindow);
  const chargeable = rows.filter(r => ['RESERVED', 'DECLINED', 'CHARGE_PENDING'].includes(r.status));
  const charged = rows.filter(r => ['CHARGED', 'SHIPPED'].includes(r.status));
  const window = chargeWindow(wave.shipDate, desk.campaign.chargeWindowDays);
  const cents = (list: Reservation[]) => list.reduce((sum, r) => sum + r.qty * price, 0);
  const failed = late.filter(r => r.refundState === 'FAILED');
  const refunding = late.filter(r => r.refundState === 'PENDING' || (!r.refundState && desk.campaign.autoProtect));
  const autoRefunded = rows.filter(r => r.refundAutomatic && r.refundId && !r.captureId);
  return { rows, late, failed, refunding, autoRefunded, chargeable, charged, window, lateCents: cents(late), failedCents: cents(failed), autoRefundedCents: cents(autoRefunded), chargeableCents: cents(chargeable), chargedCents: cents(charged) };
}

function waveState(desk: Desk, wave: Wave): WaveState {
  const f = waveFigures(desk, wave);
  if (f.failed.length) return { kind: 'late', label: `Refund failed ${money(f.failedCents, desk.campaign.currency)}` };
  if (f.late.length && desk.holds?.some(h => h.waveId === wave.id)) return { kind: 'protect', label: `Undo window · ${money(f.lateCents, desk.campaign.currency)}` };
  if (f.late.length && f.refunding.length === f.late.length) return { kind: 'protect', label: `Auto-refunding ${money(f.lateCents, desk.campaign.currency)}` };
  if (f.late.length) return { kind: 'late', label: `Refund due ${money(f.lateCents, desk.campaign.currency)}` };
  if (f.window.eligible && f.chargeable.length) return { kind: 'open', label: 'Charge open' };
  if (f.rows.length && !f.chargeable.length && f.charged.length) return { kind: 'done', label: 'Charged' };
  if (f.window.closed) return { kind: 'closed', label: 'Window closed' };
  return { kind: 'wait', label: `Opens ${shortDate(f.window.opens)}` };
}

function replanSummary(before: Desk, after: Desk, waveId: string): Replan | null {
  const a = before.waves.find(w => w.id === waveId); const b = after.waves.find(w => w.id === waveId);
  if (!a || !b) return null;
  const fa = waveFigures(before, a); const fb = waveFigures(after, b);
  return { wave: b.number, from: a.shipDate, to: b.shipDate, opensFrom: fa.window.opens, opensTo: fb.window.opens, eligibleBefore: fa.window.eligible, eligibleAfter: fb.window.eligible, closedAfter: fb.window.closed, refundDue: fb.late.length, refundDueBefore: fa.late.length, refundCents: fb.lateCents, chargeable: fb.chargeable.length, chargeableCents: fb.chargeableCents };
}

class Recover extends React.Component<{ label: string; children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(`Shipday ${this.props.label} recovered from a render error`, error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="recover-state" role="alert"><strong>The {this.props.label} needs a refresh.</strong><p>Your last action was saved on the server. Reload this view to see it.</p><button className="button secondary" type="button" onClick={() => this.setState({ error: null })}>Reload {this.props.label}</button></div>;
  }
}

function Shell({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <main className={`shell ${className}`}><a className="skip-link" href="#content">Skip to content</a><header className="masthead"><a className="wordmark" href="/" aria-label="Shipday home">SHIPDAY<span>PRE-ORDER SHIPPING</span></a><div className="mast-meta">SUPPLY IN. SHIPPING PLAN OUT.</div></header><div id="content">{children}</div></main>;
}

function Setup({ config }: { config: Config | null }) {
  if (!config?.missing.length) return null;
  return <aside className="setup" role="status"><div><strong>Connect Shipday services</strong><p>Set these server environment variables to enable live reservations and supply extraction: <code>{config.missing.join(', ')}</code></p></div><a href="/api/health">Check setup</a></aside>;
}

function App() {
  const [config, setConfig] = useState<Config | null>(null);
  useEffect(() => { api<Config>('/api/config').then(setConfig).catch(() => setConfig({ missing: ['API server'], bryntumLicense: null })); }, []);
  const path = window.location.pathname;
  const merchant = path.match(/^\/merchant\/([^/]+)$/);
  const campaign = path.match(/^\/p\/([^/]+)$/);
  const reservation = path.match(/^\/r\/([^/]+)$/);
  let page: React.ReactNode;
  if (merchant) page = <Merchant slug={decodeURIComponent(merchant[1])} config={config} />;
  else if (campaign) page = <Buyer slug={decodeURIComponent(campaign[1])} cardEntry={Boolean(config?.cardEntry)} />;
  else if (reservation) page = <ReservationPage id={decodeURIComponent(reservation[1])} />;
  else page = <CampaignSetup demoSlug={config?.demoSlug || null} />;
  return <Shell><Setup config={config} /><Recover label="page" key={path}>{page}</Recover></Shell>;
}

function CampaignSetup({ demoSlug }: { demoSlug: string | null }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [campaigns, setCampaigns] = useState<CampaignIndexItem[] | null>(null);
  const [listError, setListError] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [featured, setFeatured] = useState<CampaignPublic | null>(null);
  const [featuredError, setFeaturedError] = useState('');
  useEffect(() => { api<CampaignIndexItem[]>('/api/campaigns').then(setCampaigns).catch(cause => setListError(cause instanceof Error ? cause.message : 'Campaigns could not be loaded.')); }, []);
  useEffect(() => { if (demoSlug) api<CampaignPublic>(`/api/campaigns/${encodeURIComponent(demoSlug)}`).then(setFeatured).catch(cause => setFeaturedError(cause instanceof Error ? cause.message : 'Featured campaign is unavailable.')); }, [demoSlug]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setSaving(true);
    const form = new FormData(event.currentTarget);
    try {
      const payload = new FormData();
      payload.set('name', String(form.get('name')));
      payload.set('description', String(form.get('description') || ''));
      payload.set('imageUrl', String(form.get('imageUrl') || ''));
      payload.set('priceCents', String(Math.round(Number(form.get('price')) * 100)));
      payload.set('currency', String(form.get('currency')));
      payload.set('quantity', String(Number(form.get('quantity'))));
      payload.set('shipDate', String(form.get('shipDate')));
      payload.set('chargeWindowDays', String(Number(form.get('chargeWindowDays'))));
      if (image) payload.set('image', image);
      const result = await api<{ path: string }>('/api/campaigns', { method: 'POST', body: payload });
      window.location.assign(result.path);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Campaign could not be saved.'); setSaving(false); }
  }
  async function archive(slug: string) {
    try { await api(`/api/campaigns/${encodeURIComponent(slug)}/archive`, { method: 'POST' }); setCampaigns(items => items?.filter(item => item.slug !== slug) || []); }
    catch (cause) { setListError(cause instanceof Error ? cause.message : 'Campaign could not be archived.'); }
  }
  return <section className="setup-page">
    <div className="setup-intro"><p className="kicker">PRE-ORDERS ON PAYPAL · CHARGED WHEN THEY SHIP</p><h1>Take preorders before your stock is ready.</h1><p className="lede">Buyers save PayPal at reservation and pay nothing. AI reads your factory and freight emails into a Bryntum shipping Gantt, Shipday charges each reservation only inside its charge window, and refunds the capture if that wave later slips.</p><div className="intro-actions">{demoSlug && <a className="button primary" href={`/p/${encodeURIComponent(demoSlug)}`}>Try the judge demo</a>}<a className="button quiet" href="#new-campaign">Create a campaign</a></div>
      <section className="judge-path" aria-labelledby="judge-path-title"><p className="kicker" id="judge-path-title">JUDGE PATH · ABOUT 3 MINUTES</p><ol><li><strong>Reserve the demo.</strong> Save with PayPal, or use “Reserve with a card instead” with a sandbox test card. Nothing is charged.</li><li><strong>Create a campaign</strong> below. Its merchant desk opens only in this browser. Reserve one unit on its buyer page.</li><li><strong>Paste a freight email.</strong> AI reads <code>examples/freight-update-example.txt</code> into milestones, each field beside the sentence it came from.</li><li><strong>Charge, then slip.</strong> Charge the wave on the Gantt, drag its Ship bar past the window, and refund the red wave through PayPal.</li></ol></section></div>
    {featured ? <section className="featured-campaign" aria-labelledby="featured-title"><a className="featured-photo" href={`/p/${encodeURIComponent(featured.slug)}`} aria-label={`Open ${featured.name} campaign`}>{featured.imageUrl && <img src={featured.imageUrl} alt="" />}</a><div className="featured-copy"><p className="kicker">FEATURED CAMPAIGN</p><h2 id="featured-title">{featured.name}</h2><p>{money(featured.priceCents, featured.currency)} per unit <span>·</span> Ships {dateLabel(featured.shipDate)}</p></div><a className="button primary" href={`/p/${encodeURIComponent(featured.slug)}`}>View campaign</a></section> : featuredError ? null : <div className="featured-campaign featured-loading" aria-hidden="true" />}
    <section className="campaign-index" aria-labelledby="campaign-index-title"><div className="section-heading"><div><p className="kicker">YOUR CAMPAIGNS</p><h2 id="campaign-index-title">Shipping plans</h2></div><span className="step-mark">{campaigns ? `${campaigns.length} ACTIVE` : 'LOADING'}</span></div>
      {listError && <p className="inline-error" role="alert">{listError}</p>}
      {!campaigns && !listError && <p className="index-state" role="status">Loading campaign plans…</p>}
      {campaigns?.length === 0 && <p className="index-state">Your first shipping plan starts with a product photo and a ship date.</p>}
      {campaigns && campaigns.length > 0 && <div className="campaign-list">{campaigns.map(item => <article className={`campaign-row${item.slug === demoSlug ? ' campaign-featured' : ''}`} key={item.id}>
        <a className="campaign-thumb" href={`/p/${encodeURIComponent(item.slug)}`} aria-label={`Open ${item.name} reservation page`}>{item.imageUrl ? <img src={item.imageUrl} alt="" /> : <span aria-hidden="true">{item.name.slice(0, 1)}</span>}</a>
        <div className="campaign-row-info"><span className="campaign-row-label">{item.slug === demoSlug ? 'FEATURED CAMPAIGN' : 'CAMPAIGN'}</span><a className="campaign-row-name" href={`/merchant/${encodeURIComponent(item.slug)}`}>{item.name}</a><span className="campaign-row-date">Ships {dateLabel(item.shipDate)}</span></div>
        <div className="campaign-row-count"><strong className="mono">{item.reserved}</strong><span>RESERVED</span></div>
        <div className="campaign-row-actions"><a className="button quiet" href={`/p/${encodeURIComponent(item.slug)}`}>Buyer page</a>{item.reserved === 0 && <button className="button quiet" type="button" onClick={() => void archive(item.slug)}>Archive</button>}</div>
      </article>)}</div>}
    </section>
    <form className="campaign-form panel" id="new-campaign" onSubmit={submit}>
    <div className="section-heading"><div><p className="kicker">NEW CAMPAIGN</p><h2>Product details</h2></div><span className="step-mark">01 / 01</span></div>
    <label>Product name<input name="name" autoComplete="off" minLength={2} maxLength={100} required placeholder="A name buyers recognize" /></label>
    <label>Description <span className="optional">OPTIONAL</span><textarea name="description" rows={3} maxLength={600} placeholder="What buyers are reserving, in a sentence or two" /></label>
    <label>Product image <span className="optional">JPEG, PNG, OR WEBP UP TO 5 MB</span><input name="image" type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setImage(event.currentTarget.files?.[0] || null)} /></label>
    <label>Or use an image URL <span className="optional">OPTIONAL</span><input name="imageUrl" type="url" placeholder="https://…" /></label>
    <div className="field-grid"><label>Price<input name="price" type="number" inputMode="decimal" min="0.01" max="1000000" step="0.01" required placeholder="0.00" /></label><label>Currency<select name="currency" defaultValue="USD"><option>USD</option><option>EUR</option><option>GBP</option><option>CAD</option><option>AUD</option></select></label></div>
    <div className="field-grid"><label>Units available<input name="quantity" type="number" min="1" max="100000" step="1" required placeholder="Quantity" /></label><label>Estimated ship date<input name="shipDate" type="date" required /></label></div>
    <label>Charge window <span className="optional">DAYS BEFORE SHIPPING</span><input name="chargeWindowDays" type="number" min="0" max="365" defaultValue="20" required /></label>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="form-footer"><p>Buyers are not charged when they reserve. The configured window is a merchant setting.</p><button className="button primary" disabled={saving}>{saving ? 'Creating campaign…' : 'Create campaign'}</button></div>
  </form></section>;
}

function Merchant({ slug, config }: { slug: string; config: Config | null }) {
  const [desk, setDesk] = useState<Desk | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [source, setSource] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [sourceLabel, setSourceLabel] = useState('');
  const [explain, setExplain] = useState('');
  const [tracking, setTracking] = useState<Record<string, { number: string; carrier: string; quote?: string }>>({});
  const [dispatch, setDispatch] = useState<Record<string, string>>({});
  const load = useCallback(async (): Promise<Desk | null> => { try { const next = await api<Desk>(`/api/campaigns/${encodeURIComponent(slug)}/desk`); setDesk(next); setError(''); return next; } catch (cause) { setError(cause instanceof Error ? cause.message : 'The campaign could not be loaded.'); return null; } }, [slug]);
  const [replan, setReplan] = useState<Replan | null>(null);
  const [pendingMove, setPendingMove] = useState<{ waveId: string; waveNumber: number; from: string; shipDate: string; count: number; cents: number } | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const holding = Boolean(desk?.holds?.length);
  useEffect(() => { if (!holding) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [holding]);
  useEffect(() => { if (!holding || !desk?.holds?.some(h => Date.parse(h.holdUntil) <= clock)) return; const timer = setTimeout(() => { void load(); }, 2500); return () => clearTimeout(timer); }, [holding, clock, desk, load]);
  const [ganttRevision, setGanttRevision] = useState(0);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.addEventListener('update', event => { try { if ((JSON.parse((event as MessageEvent).data) as { slug: string }).slug === slug) void load(); } catch { /* Ignore malformed server events; the next event refreshes the page. */ } });
    return () => events.close();
  }, [slug, load]);
  const campaign = desk?.campaign;
  const stats = useMemo(() => desk ? ({ reserved: desk.reserved, waves: desk.waves.length, shipped: desk.reservations.filter(r => r.status === 'SHIPPED').length }) : null, [desk]);
  const displayTasks = useMemo(() => desk?.tasks.map(waveTask => {
    const wave = desk.waves.find(w => w.id === waveTask.id);
    if (!wave) return waveTask;
    const state = waveState(desk, wave); const window = chargeWindow(wave.shipDate, desk.campaign.chargeWindowDays);
    const update = desk.updates.find(u => u.id === wave.id);
    return { ...waveTask, cls: `wave-${state.kind}`, children: waveTask.children?.map(task => {
      const kind = task.id.slice(waveTask.id.length + 1);
      const base = { ...task, draggable: kind === 'ship', resizable: false, cls: `bar-${kind}` };
      if (kind === 'charge') return state.kind === 'late' ? { ...base, name: 'Refund due: charged too early', eventColor: barColors.late, cls: 'bar-charge bar-late' } : window.eligible ? { ...base, name: 'Charge window open', eventColor: barColors.open, cls: 'bar-charge bar-open' } : window.closed ? { ...base, name: 'Charge window closed', eventColor: barColors.closed } : { ...base, name: `Charge window opens ${shortDate(window.opens)}`, eventColor: barColors.waiting };
      if (kind === 'production') return { ...base, eventColor: barColors.production };
      if (kind === 'freight') return { ...base, name: update?.vesselOrCarrier ? `Freight · ${update.vesselOrCarrier}` : 'Freight', eventColor: barColors.freight };
      if (kind === 'warehouse') return { ...base, eventColor: barColors.warehouse };
      if (kind === 'ship') return { ...base, name: `Ship ${shortDate(wave.shipDate)} · drag to replan`, eventColor: barColors.ship };
      return base;
    }).map(task => ({ ...task, style: `background-color: ${task.eventColor}; border-color: ${task.eventColor}` })) };
  }), [desk]);
  const timeRanges = useMemo(() => desk ? desk.waves.flatMap(wave => { const w = chargeWindow(wave.shipDate, desk.campaign.chargeWindowDays); return w.eligible && waveState(desk, wave).kind === 'open' ? [{ id: `range-${wave.id}`, name: `Wave ${wave.number} charge window`, startDate: w.opens, endDate: wave.shipDate, cls: 'charge-range' }] : []; }) : [], [desk]);
  function ganttNameCell(id: string, value: unknown, narrow: boolean): unknown {
    const wave = desk?.waves.find(w => w.id === id);
    if (!wave || !desk) return String(value ?? '');
    const state = waveState(desk, wave);
    return { children: [{ tag: 'span', className: 'gantt-wave-name', text: narrow ? `Wave ${wave.number}` : `Wave ${wave.number} · ${wave.units} units` }, { tag: 'span', className: `gantt-chip chip-${state.kind}`, text: state.label }] };
  }
  function tooltipHtml(task: { id: unknown; name?: unknown; startDate?: unknown; endDate?: unknown }): string {
    if (!desk) return '';
    const id = String(task.id); const wave = desk.waves.find(w => id === w.id || id.startsWith(`${w.id}-`));
    const start = task.startDate ? localIsoDate(new Date(String(task.startDate))) : ''; const end = task.endDate ? localIsoDate(new Date(String(task.endDate))) : '';
    const lines = [`<strong>${escapeHtml(String(task.name ?? ''))}</strong>`, start ? `<span class="tip-dates">${escapeHtml(shortDate(start))}${end && end !== start ? ` → ${escapeHtml(shortDate(end))}` : ''}</span>` : ''];
    if (wave) {
      const f = waveFigures(desk, wave); const update = desk.updates.find(u => u.id === wave.id);
      if (id.endsWith('-charge')) lines.push(`<span>${f.late.length ? `${f.late.length} charged too early · ${escapeHtml(money(f.lateCents, desk.campaign.currency))} to refund` : `${f.chargeable.length} to charge · ${escapeHtml(money(f.chargeableCents, desk.campaign.currency))}`}</span>`);
      if (id.endsWith('-ship')) lines.push('<span>Drag to move the ship date. Charge windows and refunds recalculate.</span>');
      if (update?.quotes[0]) lines.push(`<q>${escapeHtml(update.quotes[0])}</q><span class="tip-source">Source: ${escapeHtml(milestoneLabel(update.milestone))} email, confirmed</span>`);
    }
    return `<div class="gantt-tip">${lines.filter(Boolean).join('')}</div>`;
  }
  function dragHtml({ taskRecord, startDate }: { taskRecord: { id: unknown }; startDate: Date }): string {
    if (!desk) return '';
    const wave = desk.waves.find(w => `${w.id}-ship` === String(taskRecord.id));
    if (!wave) return '<div class="gantt-tip">Only the Ship bar replans a wave.</div>';
    const ship = localIsoDate(startDate); const w = chargeWindow(ship, desk.campaign.chargeWindowDays);
    const charged = desk.reservations.filter(r => r.waveId === wave.id && r.status === 'CHARGED' && r.capturedAt);
    const late = charged.filter(r => isoDaysBetween(r.capturedAt!, ship) > desk.campaign.chargeWindowDays);
    return `<div class="gantt-tip"><strong>Wave ${wave.number} ships ${escapeHtml(shortDate(ship))}</strong><span>Charge window opens ${escapeHtml(shortDate(w.opens))}${w.eligible ? ' · open today' : w.closed ? ' · closed' : ''}</span>${late.length ? `<span class="tip-late">${late.length} charged ${late.length === 1 ? 'order' : 'orders'} would need a refund</span>` : charged.length ? '<span class="tip-ok">Existing charges stay inside the window</span>' : ''}</div>`;
  }
  const shipDates = useMemo(() => desk?.waves.map(w => w.shipDate) || [], [desk]);
  async function extract() {
    setBusy('extract'); setError(''); setExtraction(null); setExplain('');
    const form = new FormData(); form.set('text', source); if (file) form.set('file', file);
    try { const result = await api<{ extraction: Extraction; sourceLabel: string }>(`/api/campaigns/${encodeURIComponent(slug)}/supply/extract`, { method: 'POST', body: form }); setExtraction(result.extraction); setSourceLabel(result.sourceLabel); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Supply update could not be read.'); }
    finally { setBusy(''); }
  }
  async function confirmSupply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!extraction) return;
    const form = new FormData(event.currentTarget); const date = String(form.get('date') || ''); const units = Number(form.get('units'));
    setBusy('confirm'); setError('');
    try {
      const result = await api<{ explanation: string | null; duplicate?: boolean }>(`/api/campaigns/${encodeURIComponent(slug)}/supply/confirm`, json('POST', {
        source, units, milestone: extraction.milestone, date, origin: String(form.get('origin') || '').trim() || null, destination: String(form.get('destination') || '').trim() || null, vesselOrCarrier: String(form.get('vesselOrCarrier') || '').trim() || null, quotes: extraction.quotes, confidence: extraction.confidence,
      }));
      setNotice(result.duplicate ? 'This update is already on the plan. No new wave was added.' : 'Supply update confirmed. Shipping waves have been replanned.'); setExplain(result.explanation || ''); setExtraction(null); setSource(''); setFile(null); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Supply update could not be confirmed.'); }
    finally { setBusy(''); }
  }
  async function charge(wave: Wave) {
    setBusy(`charge:${wave.id}`); setError(''); setNotice('');
    try {
      const result = await api<{ results: { id: string; status: string; captureId?: string; issue?: string; error?: string }[] }>(`/api/campaigns/${encodeURIComponent(slug)}/waves/${wave.id}/charge`, { method: 'POST' });
      const pending = result.results.filter(r => r.status === 'CHARGE_PENDING').length;
      setNotice(`Charge run finished. ${result.results.filter(r => r.status === 'CHARGED').length} completed, ${result.results.filter(r => r.status === 'DECLINED').length} declined${pending ? `, ${pending} waiting on PayPal to confirm the capture` : ''}.`); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Wave could not be charged.'); }
    finally { setBusy(''); }
  }
  async function refund(wave: Wave) {
    setBusy(`refund:${wave.id}`); setError(''); setNotice('');
    try {
      const result = await api<{ results: { status: string; refundId?: string; issue?: string; error?: string }[] }>(`/api/campaigns/${encodeURIComponent(slug)}/waves/${wave.id}/refund`, { method: 'POST' });
      const done = result.results.filter(r => r.status === 'REFUNDED');
      setGanttRevision(n => n + 1);
      (done.length ? setNotice : setError)(`Refunded ${done.length} of ${result.results.length} through PayPal${done.length ? ` (${done.map(r => r.refundId).join(', ')})` : ''}. Refunded buyers stay reserved on their saved PayPal for the new ship date.${result.results.filter(r => r.issue || r.error).map(r => ` PayPal: ${r.issue || r.error}`).join('')}`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Wave could not be refunded.'); }
    finally { setBusy(''); }
  }
  async function readTracking(wave: Wave) {
    setBusy(`read:${wave.id}`); setError(''); setNotice('');
    try {
      const result = await api<{ matched: { reservationId: string; trackingNumber: string; carrier: string; quote: string }[]; unmatched: { tracking_number: string }[] }>(`/api/campaigns/${encodeURIComponent(slug)}/waves/${wave.id}/tracking/read`, json('POST', { text: dispatch[wave.id] || '' }));
      setTracking(current => ({ ...current, ...Object.fromEntries(result.matched.map(m => [m.reservationId, { number: m.trackingNumber, carrier: m.carrier, quote: m.quote }])) }));
      setNotice(`Read ${result.matched.length} ${result.matched.length === 1 ? 'parcel' : 'parcels'} into this wave. Check each line against its source, then save to PayPal.${result.unmatched.length ? ` ${result.unmatched.length} not matched to a charged reservation: ${result.unmatched.map(u => u.tracking_number).join(', ')}.` : ''}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Dispatch confirmation could not be read.'); }
    finally { setBusy(''); }
  }
  async function saveTracking(wave: Wave) {
    if (!desk) return;
    const rows = desk.reservations.filter(r => r.waveId === wave.id && ['CHARGED', 'SHIPPED'].includes(r.status) && !r.trackingNumber);
    const items = rows.filter(r => tracking[r.id]?.number && tracking[r.id]?.carrier).map(r => ({ reservationId: r.id, trackingNumber: tracking[r.id].number, carrier: tracking[r.id].carrier }));
    if (!items.length) return;
    setBusy(`tracking:${wave.id}`); setError('');
    try { const result = await api<{ results: { error?: string }[] }>(`/api/campaigns/${encodeURIComponent(slug)}/waves/${wave.id}/tracking`, json('POST', { items })); const failures = result.results.filter(r => r.error).length; setNotice(failures ? `${failures} tracking updates need attention.` : `Tracking recorded for ${items.length} reservations.`); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Tracking could not be saved.'); }
    finally { setBusy(''); }
  }
  async function toggleAutoProtect(enabled: boolean) {
    setBusy('auto-protect'); setError('');
    try { await api(`/api/campaigns/${encodeURIComponent(slug)}/auto-protect`, json('POST', { enabled })); setNotice(enabled ? 'Auto-protect is on. Charges that slip past their window are refunded automatically.' : 'Auto-protect is off. Slipped charges wait for you to refund them.'); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Auto-protect could not be changed.'); }
    finally { setBusy(''); }
  }
  async function moveShipDate(taskRecords: { id: string; startDate?: Date }[]) {
    const task = taskRecords.find(record => desk?.waves.some(w => `${w.id}-ship` === record.id));
    if (!task?.startDate || !desk) return;
    const waveId = task.id.slice(0, -5); const shipDate = localIsoDate(task.startDate);
    const wave = desk.waves.find(w => w.id === waveId)!;
    // A drag that would refund buyers asks first; nothing is saved until the merchant confirms.
    const late = desk.reservations.filter(r => r.waveId === waveId && r.status === 'CHARGED' && r.capturedAt && !r.refundState && isoDaysBetween(r.capturedAt, shipDate) > desk.campaign.chargeWindowDays);
    if (desk.campaign.autoProtect && late.length) { setPendingMove({ waveId, waveNumber: wave.number, from: wave.shipDate, shipDate, count: late.length, cents: late.reduce((sum, r) => sum + r.qty * desk.campaign.priceCents, 0) }); return; }
    await commitMove(waveId, shipDate);
  }
  async function commitMove(waveId: string, shipDate: string) {
    if (!desk) return;
    setPendingMove(null); setBusy(`date:${waveId}`); setError('');
    const before = desk; setNotice(''); setReplan(null);
    try { await api(`/api/campaigns/${encodeURIComponent(slug)}/waves/${waveId}/date`, json('POST', { shipDate })); const after = await load(); setGanttRevision(n => n + 1); if (after) setReplan(replanSummary(before, after, waveId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Ship date could not be moved.'); await load(); }
    finally { setBusy(''); }
  }
  function cancelMove() { setPendingMove(null); setGanttRevision(n => n + 1); setNotice('Drag undone. The ship date did not change and no money moved.'); }
  async function undoHold(hold: Hold) {
    setBusy(`undo:${hold.id}`); setError(''); setReplan(null);
    try { await api(`/api/campaigns/${encodeURIComponent(slug)}/holds/${hold.id}/undo`, { method: 'POST' }); await load(); setGanttRevision(n => n + 1); setNotice(`Drag undone. Wave ships ${shortDate(hold.previousShipDate)} again and no refund was sent.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The drag could not be undone.'); await load(); }
    finally { setBusy(''); }
  }
  if (error && !desk) return <div className="page-state error-state" role="alert"><h1>Campaign unavailable</h1><p>{error}</p><a href="/">Create a campaign</a></div>;
  if (!desk || !campaign) return <div className="page-state" role="status">Loading campaign plan…</div>;
  return <section className="merchant-page">
    <div className="merchant-title"><div className="merchant-product"><div className="merchant-product-thumb">{campaign.imageUrl ? <img src={campaign.imageUrl} alt="" /> : <span aria-hidden="true">{campaign.name.slice(0, 1)}</span>}</div><div><p className="kicker">MERCHANT PLAN / <span>{slug}</span></p><h1>{campaign.name}</h1><p className="lede compact">Reservations, incoming supply, and the next charge dates.</p></div></div><a className="button quiet" href={`/p/${encodeURIComponent(slug)}`} target="_blank" rel="noreferrer">Open buyer page <span aria-hidden="true">↗</span></a></div>
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="inline-success" role="status">{notice}</p>}{explain && <p className="plan-explanation">{explain}</p>}
    <div className="workbench-head"><div className="campaign-facts"><div><span>AVAILABLE</span><strong className="mono">{desk.available} <small>UNITS</small></strong></div><div><span>RESERVED</span><strong className="mono">{stats?.reserved} <small>UNITS</small></strong></div><div><span>UNIT PRICE</span><strong className="mono">{money(campaign.priceCents, campaign.currency)}</strong></div><div><span>CHARGE WINDOW</span><strong className="mono">{campaign.chargeWindowDays} DAYS</strong></div></div><a className="copy-link" href={`/p/${encodeURIComponent(slug)}`}>BUYER LINK <span className="mono">/p/{slug}</span></a></div>
    {(() => { const items = [...desk.waves].sort((a, b) => a.number - b.number).map(wave => ({ wave, f: waveFigures(desk, wave) })); const late = items.filter(i => i.f.late.length); const open = items.filter(i => i.f.window.eligible && i.f.chargeable.length && !i.f.late.length); if (!late.length && !open.length) return null; return <div className="plan-alerts">{late.map(({ wave, f }) => { const protecting = !f.failed.length && f.refunding.length === f.late.length; return <a key={wave.id} className={`plan-alert ${protecting ? 'alert-protect' : 'alert-late'}`} href={`#wave-${wave.id}`}><span className="alert-tag">{f.failed.length ? 'REFUND FAILED' : protecting ? 'AUTO-PROTECT' : 'REFUND DUE'}</span><strong>Wave {wave.number} · {f.late.length} {f.late.length === 1 ? 'order' : 'orders'} · <span className="mono">{money(f.lateCents, campaign.currency)}</span></strong><span className="alert-copy">Charged {shortDate(f.late[0]!.capturedAt!)}, now ships {shortDate(wave.shipDate)}: {isoDaysBetween(f.late[0]!.capturedAt!, wave.shipDate)} days later, past the {campaign.chargeWindowDays}-day window.{protecting ? ' Refunding automatically through PayPal.' : f.failed.length ? ` PayPal refused: ${f.failed[0]!.refundIssue || 'refund failed'}.` : ''}</span><span className="alert-go">{f.failed.length ? 'Retry refund →' : protecting ? 'View progress →' : 'Review refund →'}</span></a>; })}{open.map(({ wave, f }) => <a key={wave.id} className="plan-alert alert-open" href={`#wave-${wave.id}`}><span className="alert-tag">READY TO CHARGE</span><strong>Wave {wave.number} · {f.chargeable.length} {f.chargeable.length === 1 ? 'reservation' : 'reservations'} · <span className="mono">{money(f.chargeableCents, campaign.currency)}</span></strong><span className="alert-copy">Charge window open until ship day, {shortDate(wave.shipDate)}.</span><span className="alert-go">Charge wave →</span></a>)}</div>; })()}
    {desk.waves.length > 0 && desk.reserved === 0 && <div className="plan-alert alert-info" role="status"><span className="alert-tag">NEXT STEP</span><strong>Waves are planned. Nobody has reserved yet.</strong><span className="alert-copy">Reserve one unit on the buyer page (PayPal or the sandbox test card, nothing is charged). It lands in Wave 1 and the charge button unlocks inside the window.</span><a className="alert-go" href={`/p/${encodeURIComponent(slug)}`} target="_blank" rel="noreferrer">Open buyer page ↗</a></div>}
    <section className="timeline-section" aria-labelledby="timeline-title"><div className="section-heading timeline-heading"><div><p className="kicker">LIVE SHIPPING PLAN</p><h2 id="timeline-title">Waves and milestones</h2></div><div className="legend" aria-label="Timeline legend"><span><i className="dot production" /> Production</span><span><i className="dot freight" /> Freight</span><span><i className="dot warehouse" /> Warehouse</span><span><i className="dot charge" /> Charge window open</span><span><i className="dot waiting" /> Window not open</span><span><i className="dot late" /> Refund due</span><span><i className="dot shipped" /> Ship day (drag)</span><span><i className="line today" /> Today</span></div></div>
      {pendingMove && <div className="replan-card replan-late grace-confirm" role="alertdialog" aria-labelledby="grace-confirm-title"><div><p className="kicker">CONFIRM REPLAN · AUTO-PROTECT</p><strong id="grace-confirm-title">{pendingMove.count} {pendingMove.count === 1 ? 'buyer' : 'buyers'} (<span className="mono">{money(pendingMove.cents, campaign.currency)}</span>) will be auto-refunded.</strong><ul><li>Wave {pendingMove.waveNumber} moves <span className="mono">{shortDate(pendingMove.from)}</span> → <span className="mono">{shortDate(pendingMove.shipDate)}</span>, past the {campaign.chargeWindowDays}-day charge window for {pendingMove.count === 1 ? 'its charge' : 'their charges'}.</li><li>After you confirm, refunds wait {desk.graceSeconds ?? 60} seconds so you can still undo. Buyers stay reserved and are charged again inside the new window.</li></ul></div><div className="grace-actions"><button className="button refund-button" type="button" disabled={Boolean(busy)} onClick={() => { void commitMove(pendingMove.waveId, pendingMove.shipDate); }}>Confirm</button><button className="button secondary" type="button" onClick={cancelMove}>Undo drag</button></div></div>}
      {(desk.holds || []).map(hold => { const wave = desk.waves.find(w => w.id === hold.waveId); const left = Math.max(0, Math.ceil((Date.parse(hold.holdUntil) - clock) / 1000)); return <div key={hold.id} className="replan-card grace-toast" role="status"><div><p className="kicker">UNDO WINDOW · NOTHING SENT TO PAYPAL YET</p><strong>Wave {wave?.number ?? '?'} moved <span className="mono">{shortDate(hold.previousShipDate)}</span> → <span className="mono">{shortDate(hold.newShipDate)}</span>. {hold.refundCount} {hold.refundCount === 1 ? 'buyer' : 'buyers'} (<span className="mono">{money(hold.refundCents, campaign.currency)}</span>) {left ? <>will be auto-refunded in <span className="mono">{left}s</span>.</> : 'are being auto-refunded now.'}</strong></div>{left > 0 && <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => { void undoHold(hold); }}>{busy === `undo:${hold.id}` ? 'Undoing…' : 'Undo drag'}</button>}</div>; })}
      {replan && <div className={`replan-card ${replan.refundDue ? 'replan-late' : replan.eligibleAfter && !replan.eligibleBefore ? 'replan-open' : ''}`} role="status"><div><p className="kicker">REPLANNED BY DRAG</p><strong>Wave {replan.wave} now ships <span className="mono">{shortDate(replan.to)}</span> <span className="replan-was">(was {shortDate(replan.from)}, {isoDaysBetween(replan.from, replan.to) > 0 ? '+' : ''}{isoDaysBetween(replan.from, replan.to)} days)</span></strong><ul><li>Charge window opens <span className="mono">{shortDate(replan.opensTo)}</span>{replan.opensTo !== replan.opensFrom && <> (was {shortDate(replan.opensFrom)})</>}.{replan.eligibleAfter ? replan.eligibleBefore ? ' Still open today.' : ' Charging is now open.' : replan.closedAfter ? ' Ship day has passed, so charging is locked.' : ' Charging is locked until then.'}</li>{replan.refundDue > 0 ? <li className="replan-money-late">{replan.refundDue} charged {replan.refundDue === 1 ? 'order now ships' : 'orders now ship'} outside the {campaign.chargeWindowDays}-day window: <span className="mono">{money(replan.refundCents, campaign.currency)}</span> {campaign.autoProtect ? 'refunding automatically (auto-protect).' : 'refund due.'}</li> : replan.refundDueBefore > 0 ? <li>Charges are back inside the window. No refund needed.</li> : null}{replan.eligibleAfter && replan.chargeable > 0 && <li>{replan.chargeable} {replan.chargeable === 1 ? 'reservation' : 'reservations'} ready to charge: <span className="mono">{money(replan.chargeableCents, campaign.currency)}</span>.</li>}</ul></div><button className="button quiet" type="button" onClick={() => setReplan(null)}>Dismiss</button></div>}
      {desk.tasks.length ? <div className="gantt-frame" style={{ ['--gantt-rows' as string]: String(desk.tasks.reduce((n, t) => n + 1 + (t.children?.length || 0), 0)), height: Math.min(580, 96 + 48 * desk.tasks.reduce((rows, task) => rows + 1 + (task.children?.length || 0), 0)) }}><GanttPanel revision={ganttRevision} tasks={displayTasks || []} dependencies={desk.dependencies} shipDates={shipDates} timeRanges={timeRanges} nameCell={ganttNameCell} tooltip={tooltipHtml} dragTooltip={dragHtml} onDrop={records => { void moveShipDate(records); }} />{busy.startsWith('date:') && <span className="gantt-saving" role="status">Replanning wave and charge windows…</span>}</div> : desk.updates.length ? <div className="empty-plan"><div><p className="kicker">SUPPLY CONFIRMED · NO RESERVATIONS YET</p><h3>Supply is confirmed. Waves appear when a unit is reserved.</h3><p>Open the buyer page and reserve with PayPal or the sandbox test card. Nothing is charged. The planner then puts that reservation in a wave you can charge.</p><a className="button primary" href={`/p/${encodeURIComponent(slug)}`} target="_blank" rel="noreferrer">Open the buyer page to reserve ↗</a></div></div> : <div className="empty-plan"><div><p className="kicker">AWAITING CONFIRMED SUPPLY</p><h3>Confirm your first supply update to plan waves.</h3><p>Paste a forwarder or production update below, or start with <code>examples/freight-update-example.txt</code>. AI reads it into milestones with the sentence each one came from.</p></div></div>}
      <p className="timeline-hint">Drag a green <strong>Ship</strong> bar to replan its wave: the charge window moves with it, and any charge that now falls outside the {campaign.chargeWindowDays}-day window turns red as refund due. Hover a bar for the email sentence it came from.</p>
    </section>
    <div className="operations-grid"><section className="supply-section panel" aria-labelledby="supply-title"><div className="section-heading"><div><p className="kicker">SUPPLY IN</p><h2 id="supply-title">Update from a supplier</h2></div><span className="section-index">01</span></div><label htmlFor="supply-source">Paste an email, or attach a packing list or freight document</label><textarea id="supply-source" rows={7} value={source} onChange={e => setSource(e.target.value)} placeholder="Paste the factory or forwarder update here…" /><div className="supply-actions"><label className="file-pick">Attach PDF or photo<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={e => setFile(e.target.files?.[0] || null)} /></label>{file && <span className="file-name">{file.name}</span>}<button className="button secondary" onClick={() => { void extract(); }} disabled={busy === 'extract' || (!source.trim() && !file)}>{busy === 'extract' ? 'Reading source…' : 'Read update'}</button></div><p className="help-copy">AI extracts dates and quantities only when the source supports them. Every field stays linked to its quoted sentence.</p>
      {extraction && <form className="extraction" onSubmit={confirmSupply}><div className="extraction-heading"><div><p className="kicker">SOURCE CHECK</p><h3>Review extracted details</h3></div><span className="source-name">{sourceLabel}</span></div><label>Units <span className="mono">{extraction.field_quotes.units ? `“${extraction.field_quotes.units}”` : 'No source quote'}</span><input name="units" type="number" min="1" required defaultValue={extraction.units ?? ''} /></label><div className="field-grid"><label>Milestone <span className="mono quote">“{extraction.field_quotes.milestone}”</span><select value={extraction.milestone} onChange={e => setExtraction({ ...extraction, milestone: e.target.value })}><option value="production_complete">Production complete</option><option value="departed">Departed</option><option value="arrived_port">Arrived at port</option><option value="arrived_warehouse">Arrived at warehouse</option><option value="delayed">Delayed</option></select></label><label>Event date <span className="mono quote">{extraction.field_quotes.date ? `“${extraction.field_quotes.date}”` : extraction.eta ? `“${extraction.field_quotes.eta}”` : 'No source quote'}</span><input name="date" type="date" required defaultValue={extraction.date || ''} /></label></div><div className="field-grid"><label>Origin <span className="mono quote">{extraction.field_quotes.origin ? `“${extraction.field_quotes.origin}”` : 'No source quote'}</span><input name="origin" defaultValue={extraction.origin || ''} /></label><label>Destination <span className="mono quote">{extraction.field_quotes.destination ? `“${extraction.field_quotes.destination}”` : 'No source quote'}</span><input name="destination" defaultValue={extraction.destination || ''} /></label></div><label>Vessel or carrier <span className="mono quote">{extraction.field_quotes.vessel_or_carrier ? `“${extraction.field_quotes.vessel_or_carrier}”` : 'No source quote'}</span><input name="vesselOrCarrier" defaultValue={extraction.vessel_or_carrier || ''} /></label><p className="quote-list"><strong>Source sentences</strong>{extraction.quotes.map((quote, i) => <q key={`${i}-${quote}`}>{quote}</q>)}</p><p className="confidence mono">Confidence {(extraction.confidence * 100).toFixed(0)}%</p><button className="button primary" disabled={busy === 'confirm'}>{busy === 'confirm' ? 'Confirming and replanning…' : 'Confirm update and replan'}</button></form>}
    </section>
    <section className="wave-section" aria-labelledby="wave-title"><div className="section-heading"><div><p className="kicker">PLAN OUT</p><h2 id="wave-title">Wave actions</h2></div><label className="autoprotect-toggle"><input type="checkbox" checked={campaign.autoProtect !== false} disabled={Boolean(busy)} onChange={e => { void toggleAutoProtect(e.target.checked); }} /><span><strong>Auto-protect</strong> Refund automatically if a wave slips past its charge window</span></label><span className="section-index">02</span></div>{desk.waves.length ? <div className="wave-list">{[...desk.waves].sort((a, b) => a.number - b.number).map(wave => { const window = chargeWindow(wave.shipDate, campaign.chargeWindowDays); const rows = desk.reservations.filter(r => r.waveId === wave.id); const chargeable = rows.filter(r => ['RESERVED', 'DECLINED', 'CHARGE_PENDING'].includes(r.status)); const canShip = rows.filter(r => ['CHARGED', 'SHIPPED'].includes(r.status) && !r.outsideWindow); const late = rows.filter(r => r.outsideWindow); const figures = waveFigures(desk, wave); const state = waveState(desk, wave); const update = desk.updates.find(u => u.id === wave.id); return <article className={`wave-card wave-card-${state.kind}`} id={`wave-${wave.id}`} key={wave.id}><div className="wave-card-head"><div><p className="kicker">WAVE {String(wave.number).padStart(2, '0')} <span className={`gantt-chip chip-${state.kind}`}>{state.label}</span></p><h3>{wave.units} <span>UNITS</span></h3></div><div className="wave-ship"><span>SHIPS</span><time className="mono" dateTime={wave.shipDate}>{dateLabel(wave.shipDate, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}</time></div></div><p className="wave-detail">{rows.length} reservations <span>·</span> {rows.filter(r => r.status === 'SHIPPED').length} shipped <span>·</span> <span className="mono">{money(figures.chargedCents, campaign.currency)}</span> charged{figures.chargeable.length > 0 && <> <span>·</span> <span className="mono">{money(figures.chargeableCents, campaign.currency)}</span> to charge</>}</p>{update && <blockquote className="wave-source"><span>FROM THE {milestoneLabel(update.milestone).toUpperCase()} EMAIL · {update.units} UNITS</span><q>{update.quotes[0]}</q></blockquote>}{!(late.length && !chargeable.length) && <button className={`button ${window.eligible ? 'charge-button' : 'secondary'}`} disabled={!window.eligible || !chargeable.length || Boolean(busy)} title={window.closed ? `The charge window closed on ${dateLabel(wave.shipDate)}.` : !window.eligible ? `Charging opens ${dateLabel(window.opens)}.` : undefined} onClick={() => { void charge(wave); }}>{busy === `charge:${wave.id}` ? 'Charging each reservation…' : `Charge Wave ${wave.number} (${chargeable.length} ${chargeable.length === 1 ? 'reservation' : 'reservations'})`}</button>}{window.closed && <p className="disabled-reason">The charge window closed on {dateLabel(wave.shipDate)}. Drag the Ship bar to a new date to reopen it.</p>}{!window.eligible && !window.closed && <p className="disabled-reason">Charging opens {dateLabel(window.opens)}. The window runs through ship day.</p>}{window.eligible && !chargeable.length && !late.length && <p className="disabled-reason">No reserved or retryable payments in this wave.</p>}{late.length > 0 && (figures.failed.length || !campaign.autoProtect ? <div className="refund-due" role="status"><p>{figures.failed.length > 0 && <><strong className="refund-failed">Auto-refund failed for {figures.failed.length} {figures.failed.length === 1 ? 'charge' : 'charges'}: PayPal said {figures.failed[0]!.refundIssue || 'the refund failed'}.</strong> Nothing was marked refunded{(figures.failed[0]!.refundAttempts || 0) < 3 && figures.failed[0]!.refundNextAttemptAt ? `; Shipday retries automatically after ${new Date(figures.failed[0]!.refundNextAttemptAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : '; automatic retries are used up'}. </>}<strong>{late.length} charged {late.length === 1 ? 'order ships' : 'orders ship'} {Math.round((Date.parse(`${wave.shipDate}T00:00:00Z`) - Date.parse(`${late[0]!.capturedAt!.slice(0, 10)}T00:00:00Z`)) / 86_400_000)} days after the charge.</strong> That is past the {campaign.chargeWindowDays} day window. Refund now and Shipday charges the same saved PayPal again when the new window opens.</p><button className="button refund-button" disabled={Boolean(busy)} onClick={() => { void refund(wave); }}>{busy === `refund:${wave.id}` ? 'Refunding through PayPal…' : figures.failed.length ? `Retry refund now (${figures.failed.length})` : `Refund ${late.length} and hold for ${dateLabel(wave.shipDate, { day: 'numeric', month: 'short', timeZone: 'UTC' })}`}</button></div> : <div className="refund-due refund-protect" role="status"><p><span className="gantt-chip chip-protect">AUTO-PROTECT</span> <strong>{late.length} charged {late.length === 1 ? 'order ships' : 'orders ship'} Math.round((Date.parse(`${wave.shipDate}T00:00:00Z`) - Date.parse(`${late[0]!.capturedAt!.slice(0, 10)}T00:00:00Z`)) / 86_400_000) days after the charge, past the {campaign.chargeWindowDays} day window.</strong> {desk.holds?.some(h => h.waveId === wave.id) ? <>Refunds of <span className="mono">{money(figures.lateCents, campaign.currency)}</span> are held for the undo window. Nothing has been sent to PayPal yet.</> : <>Shipday is refunding <span className="mono">{money(figures.lateCents, campaign.currency)}</span> through PayPal automatically.</>} Buyers stay reserved and are charged again inside the new window.</p></div>)}{figures.autoRefunded.length > 0 && !late.length && <div className="autorefunded-note" role="status"><span className="gantt-chip chip-refunded">AUTO-REFUNDED</span> <span>Auto-protect refunded {figures.autoRefunded.length} {figures.autoRefunded.length === 1 ? 'buyer' : 'buyers'} · <span className="mono">{money(figures.autoRefundedCents, campaign.currency)}</span> after the ship date moved past the window. They stay reserved for {dateLabel(wave.shipDate, { day: 'numeric', month: 'short', timeZone: 'UTC' })}.</span></div>}
        {rows.length > 0 && <div className="reservation-list"><h4>RESERVATIONS</h4>{rows.map(row => <div className="reservation-row" key={row.id}><div className="reservation-main"><span className="mono">#{row.position} · {row.qty} {row.qty === 1 ? 'unit' : 'units'}</span><strong className={`status status-${row.status.toLowerCase()}`}>{statusLabel(row.status)}</strong></div>{row.captureId && <p className="proof mono">Capture {row.captureId}</p>}{row.refundId && !row.captureId && <p className={`proof mono${row.refundAutomatic ? ' proof-refunded' : ''}`}>{row.refundAutomatic ? `Auto-refunded${row.refundedAt ? ` ${shortDate(row.refundedAt)}` : ''} · ` : ''}Refund {row.refundId} · still reserved</p>}{row.refundState === 'PENDING' && <p className="proof mono">Refund in progress through PayPal…</p>}{row.refundState === 'FAILED' && <p className="row-issue">Refund failed: {row.refundIssue || 'PayPal refused the refund'}. Still charged.</p>}{row.outsideWindow && <p className="row-issue">Charged {dateLabel(row.capturedAt!, { day: 'numeric', month: 'short', timeZone: 'UTC' })}, now ships outside the window.</p>}{row.issue && <p className="row-issue">PayPal declined: {row.issue}</p>}{row.status === 'CHARGE_PENDING' && <p className="row-issue">PayPal has not confirmed a final capture yet.</p>}{row.status === 'SHIPPED' && <p className="proof mono">Tracking {row.carrier} · {row.trackingNumber}</p>}</div>)}</div>}
        {canShip.some(r => !r.trackingNumber) && <div className="dispatch-read"><h4>READ DISPATCH CONFIRMATION</h4><label className="visually-hidden" htmlFor={`dispatch-${wave.id}`}>Carrier or warehouse dispatch confirmation for wave {wave.number}</label><textarea id={`dispatch-${wave.id}`} rows={4} value={dispatch[wave.id] || ''} onChange={e => setDispatch({ ...dispatch, [wave.id]: e.target.value })} placeholder="Paste the carrier or 3PL dispatch email" /><button className="button secondary" disabled={!(dispatch[wave.id] || '').trim() || Boolean(busy)} onClick={() => { void readTracking(wave); }}>{busy === `read:${wave.id}` ? 'Reading parcels…' : 'Read tracking numbers'}</button></div>}
        {canShip.length > 0 && <div className="tracking-form"><h4>MARK SHIPPED</h4>{canShip.filter(r => !r.trackingNumber).map(row => <div className="tracking-row" key={row.id}><span className="mono">#{row.position}</span><label className="visually-hidden" htmlFor={`carrier-${row.id}`}>Carrier for reservation {row.position}</label><select id={`carrier-${row.id}`} value={tracking[row.id]?.carrier || ''} onChange={e => setTracking({ ...tracking, [row.id]: { ...tracking[row.id], number: tracking[row.id]?.number || '', carrier: e.target.value } })}><option value="">Carrier</option>{['USPS', 'UPS', 'FEDEX', 'DHL', 'ONTRAC'].map(value => <option key={value}>{value}</option>)}</select><label className="visually-hidden" htmlFor={`tracking-${row.id}`}>Tracking number for reservation {row.position}</label><input id={`tracking-${row.id}`} value={tracking[row.id]?.number || ''} onChange={e => setTracking({ ...tracking, [row.id]: { ...tracking[row.id], number: e.target.value, carrier: tracking[row.id]?.carrier || '' } })} placeholder="Tracking number" />{tracking[row.id]?.quote && <p className="proof tracking-quote">“{tracking[row.id]!.quote}”</p>}</div>)}<button className="button secondary" disabled={!canShip.some(r => tracking[r.id]?.number && tracking[r.id]?.carrier) || Boolean(busy)} onClick={() => { void saveTracking(wave); }}>{busy === `tracking:${wave.id}` ? 'Saving tracking…' : 'Save tracking and mark shipped'}</button></div>}
      </article>; })}</div> : <div className="empty-wave"><p>{desk.updates.length ? 'Supply is confirmed. Waves appear here when the first unit is reserved on the buyer page.' : 'Waves appear after a supply update is confirmed and reservation units are allocated.'}</p></div>}</section></div>
    {desk.updates.length > 0 && <section className="updates-section"><div className="section-heading"><div><p className="kicker">CONFIRMED SOURCE RECORD</p><h2>Supply history</h2></div></div><ol className="update-list">{desk.updates.map(update => <li key={update.id}><time className="mono">{dateLabel(update.date, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}</time><div><strong>{update.units} units · {milestoneLabel(update.milestone)}</strong><p>{update.quotes.map((quote, i) => <React.Fragment key={i}>{i > 0 && ' '}<q>{quote}</q></React.Fragment>)}</p>{(() => { const wave = desk.waves.find(w => w.id === update.id); return wave ? <a className="update-wave" href={`#wave-${wave.id}`}>Created Wave {wave.number} · ships <span className="mono">{shortDate(wave.shipDate)}</span> →</a> : null; })()}</div></li>)}</ol></section>}
    {(desk.ledger?.length ?? 0) > 0 && <section className="ledger-section" aria-labelledby="ledger-title"><div className="section-heading"><div><p className="kicker">PAYPAL MONEY LEDGER</p><h2 id="ledger-title">Refund activity</h2></div></div><ol className="ledger-list">{desk.ledger!.map(entry => { const ok = entry.kind === 'AUTO_REFUND' || entry.kind === 'REFUND'; const auto = entry.kind.startsWith('AUTO'); return <li key={entry.id} className={ok ? 'ledger-ok' : 'ledger-failed'}><time className="mono" dateTime={entry.at}>{new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(entry.at))}</time><div><p className="ledger-head"><span className={`gantt-chip ${ok ? 'chip-refunded' : 'chip-late'}`}>{ok ? auto ? 'AUTO-REFUNDED' : 'REFUNDED' : 'REFUND FAILED'}</span> <strong>#{entry.position ?? '?'} · <span className="mono">{entry.amountCents != null && entry.currency ? money(entry.amountCents, entry.currency) : ''}</span>{entry.waveNumber != null && <> · Wave {entry.waveNumber}</>}</strong> <span className="ledger-actor">by {entry.actor}{auto && entry.actor === 'merchant' ? ' (retry)' : ''}</span></p><p>{entry.oldShipDate ? <>Ship date moved <span className="mono">{shortDate(entry.oldShipDate)}</span> → <span className="mono">{entry.newShipDate ? shortDate(entry.newShipDate) : '?'}</span></> : <>Ship date now <span className="mono">{entry.newShipDate ? shortDate(entry.newShipDate) : '?'}</span></>}{entry.chargedAt && <>, charged <span className="mono">{shortDate(entry.chargedAt)}</span></>}{entry.windowDays != null && <>, outside the {entry.windowDays}-day window</>}.{!ok && entry.issue && <> PayPal: {entry.issue}. Attempt {entry.attempt}.</>}</p><p className="proof mono">Capture {entry.captureId}{entry.refundId && <> → refund {entry.refundId}{entry.paypalStatus && <> · {entry.paypalStatus}</>}</>}</p></div></li>; })}</ol></section>}
    {config?.bryntumLicense && <span className="sr-only">Bryntum Gantt license configured.</span>}
  </section>;
}

function Buyer({ slug, cardEntry }: { slug: string; cardEntry: boolean }) {
  const [campaign, setCampaign] = useState<CampaignPublic | null>(null); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const [imageFailed, setImageFailed] = useState(false); const [email, setEmail] = useState('');
  useEffect(() => { api<CampaignPublic>(`/api/campaigns/${encodeURIComponent(slug)}`).then(setCampaign).catch(cause => setError(cause instanceof Error ? cause.message : 'Campaign not found.')); }, [slug]);
  async function reserve(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!campaign) return; setSaving(true); setError(''); const form = new FormData(event.currentTarget);
    try { const result = await api<{ approvalUrl: string }>(`/api/campaigns/${encodeURIComponent(slug)}/reservations`, json('POST', { email: form.get('email'), qty: Number(form.get('qty')) })); window.location.assign(result.approvalUrl); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Reservation could not be started.'); setSaving(false); }
  }
  async function reserveCard(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!campaign) return; setSaving(true); setError(''); const form = new FormData(event.currentTarget);
    try { const result = await api<{ path: string }>(`/api/campaigns/${encodeURIComponent(slug)}/reservations/card`, json('POST', { email: form.get('email'), qty: Number(form.get('qty')), name: form.get('cardName'), number: String(form.get('cardNumber') || '').replace(/\D/g, ''), expiry: form.get('cardExpiry'), securityCode: form.get('cardCode') })); window.location.assign(result.path); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Card could not be saved.'); setSaving(false); }
  }
  if (error && !campaign) return <div className="page-state error-state" role="alert"><h1>Campaign unavailable</h1><p>{error}</p></div>;
  if (!campaign) return <div className="page-state" role="status">Loading campaign details…</div>;
  const date = campaign.shipDate;
  return <section className="buyer-page"><div className="buyer-label"><span>SHIPDAY RESERVATION</span><span>Check order status from your saved reservation link.</span></div><div className="buyer-layout"><div className="product-image">{campaign.imageUrl && !imageFailed ? <img src={campaign.imageUrl} alt={campaign.name} width={2000} height={1235} fetchPriority="high" decoding="async" onError={() => setImageFailed(true)} /> : <div className="product-image-fallback"><span>PRODUCT</span><strong>{campaign.name.slice(0, 1)}</strong><b>{campaign.name}</b></div>}</div><div className="buyer-copy"><h1>{campaign.name}</h1>{campaign.description && <p className="buyer-description">{campaign.description}</p>}<p className="buyer-price">{money(campaign.priceCents, campaign.currency)} <span>per unit</span></p><p className="ship-date-label">Estimated ship date</p><time className="buyer-date" dateTime={date}>{dateLabel(date, { day: 'numeric', month: 'long', timeZone: 'UTC' })}</time><section className="pay-ledger" aria-labelledby="pay-ledger-title"><h2 id="pay-ledger-title">You are charged only when it ships.</h2><ol><li className="ledger-today"><span className="ledger-when">Today</span><strong className="mono">{money(0, campaign.currency)}</strong><span className="ledger-what">PayPal saves your payment. Nothing is charged.</span></li><li className="ledger-ship"><span className="ledger-when">Ship week, about {shortDate(date)}</span><strong className="mono">{money(campaign.priceCents, campaign.currency)}</strong><span className="ledger-what">Charged when your unit is ready to leave the warehouse.</span></li><li className="ledger-slip"><span className="ledger-when">If the date slips</span><strong>Refunded</strong><span className="ledger-what">A charge that ends up more than {campaign.chargeWindowDays} days before shipping is refunded in full. You keep your place.</span></li></ol></section><form className="reserve-form" onSubmit={reserve}><label>Email for your reservation<input name="email" type="email" autoComplete="email" required placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} /></label><label>Units<input name="qty" type="number" min="1" max={Math.min(100, campaign.available || 0)} defaultValue="1" required /></label><button className="button paypal-button reserve-button" disabled={saving || campaign.available === 0}>{saving ? 'Opening PayPal…' : <><span>Save with</span><span className="pp-wordmark" aria-label="PayPal"><b>Pay</b><i>Pal</i></span><span className="pp-sub">· pay when it ships</span></>}</button>{error && <p role="alert" className="inline-error">{error}</p>}<p className="charge-copy">Nothing is charged today. We charge your PayPal within the {campaign.chargeWindowDays}-day window before shipping, currently planned for {dateLabel(date)}.</p></form>{cardEntry && <details className="card-reserve"><summary>Reserve with a card instead</summary><form className="reserve-form" onSubmit={reserveCard}><label>Email for your reservation<input name="email" type="email" autoComplete="email" required placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} /></label><label>Units<input name="qty" type="number" min="1" max={Math.min(100, campaign.available || 0)} defaultValue="1" required /></label><label>Name on card<input name="cardName" autoComplete="cc-name" required minLength={2} /></label><label>Card number<input name="cardNumber" inputMode="numeric" autoComplete="cc-number" required pattern="[0-9 ]{12,23}" /></label><div className="field-grid"><label>Expiry<input name="cardExpiry" type="month" autoComplete="cc-exp" required /></label><label>Security code<input name="cardCode" inputMode="numeric" autoComplete="cc-csc" required pattern="[0-9]{3,4}" /></label></div><button className="button primary reserve-button" disabled={saving || campaign.available === 0}>{saving ? 'Saving card with PayPal…' : 'Save card. Pay when it ships.'}</button><p className="charge-copy">PayPal saves the card in its vault. Nothing is charged today.</p></form></details>}<p className="availability mono">{campaign.available} UNITS AVAILABLE <span>·</span> {money(campaign.priceCents, campaign.currency)} EACH</p><aside className="money-rule"><strong>Your payment is saved securely with PayPal.</strong><p>Shipday does not charge when you reserve. You can cancel any time before a charge begins.</p></aside><details className="policy-note"><summary>PayPal pre-order shipping policy</summary><p>{campaign.policy.quote}</p><a href={campaign.policy.url} target="_blank" rel="noreferrer">Read PayPal Seller Protection</a><small>Checked {campaign.policy.checkedAt}. This is a Seller Protection condition, not a universal charge timing rule.</small></details></div></div></section>;
}

function ReservationPage({ id }: { id: string }) {
  const [reservation, setReservation] = useState<{ id: string; qty: number; position: number; status: string; captureId: string | null; issue: string | null; campaignName: string; imageUrl: string | null; shipDate: string; chargeWindowDays: number; currency: string; amountCents: number; canCancel: boolean; refund: { refundId: string; reason: string; refundedAt: string; automatic?: boolean; amountCents?: number; oldShipDate?: string | null; newShipDate?: string | null } | null; refundInProgress?: 'PENDING' | 'FAILED' | null } | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<typeof reservation>(`/api/reservations/${encodeURIComponent(id)}`).then(value => setReservation(value)).catch(cause => setError(cause instanceof Error ? cause.message : 'Reservation not found.')), [id]);
  useEffect(() => { void load(); }, [load]);
  async function cancel() { setBusy(true); setError(''); try { await api(`/api/reservations/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); setNotice('Reservation cancelled. The saved PayPal payment token was removed.'); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Reservation could not be cancelled.'); } finally { setBusy(false); } }
  if (error && !reservation) return <div className="page-state error-state" role="alert"><h1>Reservation unavailable</h1><p>{error}</p></div>;
  if (!reservation) return <div className="page-state" role="status">Loading reservation…</div>;
  const autoRefund = reservation.refund?.automatic && ['RESERVED', 'CHARGE_PENDING', 'DECLINED'].includes(reservation.status) ? reservation.refund : null;
  const status = autoRefund ? 'Auto-refunded · still reserved' : statusLabel(reservation.status);
  const refunded = reservation.refund && ['RESERVED', 'CHARGE_PENDING', 'DECLINED'].includes(reservation.status) ? reservation.refund : null;
  return <section className="receipt-page"><div className="receipt-mark">SHIPDAY <span>PLAN POSITION {reservation.position}</span></div>{reservation.imageUrl && <img className="receipt-product-image" src={reservation.imageUrl} alt={reservation.campaignName} />}{new URLSearchParams(window.location.search).get('paypal') === 'reserved' && <p className="inline-success" role="status">Saved. Not charged yet.</p>}{notice && <p className="inline-success" role="status">{notice}</p>}{error && <p className="inline-error" role="alert">{error}</p>}{autoRefund && <div className="autorefund-banner" role="status"><span className="gantt-chip chip-refunded">AUTO-REFUNDED</span><p><strong>Your <span className="mono">{money(autoRefund.amountCents ?? reservation.amountCents, reservation.currency)}</span> was refunded automatically</strong> on {dateLabel(autoRefund.refundedAt, { day: 'numeric', month: 'long', timeZone: 'UTC' })} because the ship date moved past the {reservation.chargeWindowDays}-day window{autoRefund.oldShipDate && autoRefund.newShipDate ? ` (it moved from ${dateLabel(autoRefund.oldShipDate, { day: 'numeric', month: 'short', timeZone: 'UTC' })} to ${dateLabel(autoRefund.newShipDate, { day: 'numeric', month: 'short', timeZone: 'UTC' })})` : ''}. You don't need to do anything.</p></div>}{reservation.refundInProgress === 'PENDING' && <p className="inline-success" role="status">The ship date moved past the charge window. Shipday is refunding your payment through PayPal now.</p>}<p className="kicker">{reservation.campaignName}</p><h1>{autoRefund ? 'Auto-refunded. Still reserved.' : refunded ? 'Refunded. Still reserved.' : reservation.status === 'CHARGED' ? 'Charged today.' : reservation.status === 'SHIPPED' ? 'Shipping update.' : reservation.status === 'CANCELLED' ? 'Reservation cancelled.' : reservation.status === 'PENDING' ? 'Finish saving PayPal.' : 'Your reservation is saved.'}</h1><time className="receipt-date" dateTime={reservation.shipDate}>{dateLabel(reservation.shipDate, { day: 'numeric', month: 'long', timeZone: 'UTC' })}</time><p className="receipt-sentence">{autoRefund ? `You keep your place in line, planned to ship on the date above. Shipday charges your saved PayPal again only within ${reservation.chargeWindowDays} days of that date.` : refunded ? `${refunded.reason} Shipday refunded your PayPal in full and will charge it again within ${reservation.chargeWindowDays} days of the new ship date.` : reservation.status === 'CHARGED' ? 'Your PayPal payment is complete. Your unit ships on the date above.' : reservation.status === 'SHIPPED' ? 'Your order is on its way.' : reservation.status === 'CANCELLED' ? 'No payment will be collected for this reservation.' : reservation.status === 'PENDING' ? 'PayPal has not confirmed your saved payment yet. Nothing is charged until your shipping wave is ready.' : `Your order is in the shipping plan. We charge your PayPal within ${reservation.chargeWindowDays} days of shipping.`}</p><dl className="receipt-facts"><div><dt>STATUS</dt><dd className="status">{status}</dd></div><div><dt>QUANTITY</dt><dd className="mono">{reservation.qty} {reservation.qty === 1 ? 'unit' : 'units'}</dd></div><div><dt>AMOUNT WHEN CHARGED</dt><dd className="mono">{money(reservation.amountCents, reservation.currency)}</dd></div>{reservation.captureId && <div><dt>PAYPAL CAPTURE</dt><dd className="mono capture-id">{reservation.captureId}</dd></div>}{autoRefund && <div><dt>REFUNDED</dt><dd className="mono">{money(autoRefund.amountCents ?? reservation.amountCents, reservation.currency)}</dd></div>}{refunded && <div><dt>PAYPAL REFUND</dt><dd className="mono capture-id">{refunded.refundId}</dd></div>}</dl>{reservation.issue && <p className="row-issue">PayPal response: {reservation.issue}</p>}{reservation.canCancel && <button className="button secondary" disabled={busy} onClick={() => { void cancel(); }}>{busy ? 'Cancelling…' : 'Cancel reservation'}</button>}<p className="receipt-foot">Save this page to check the current plan. Reservation reference <span className="mono">{reservation.id}</span></p></section>;
}

function statusLabel(status: string) { return ({ RESERVED: 'Reserved', PENDING: 'PayPal approval pending', CANCEL_PENDING: 'Cancelling', CANCELLED: 'Cancelled', CHARGE_PENDING: 'Charge pending', DECLINED: 'Payment declined', CHARGED: 'Charged', SHIPPED: 'Shipped' } as Record<string, string>)[status] || status; }
function milestoneLabel(value: string) { return ({ production_complete: 'Production complete', departed: 'Departed', arrived_port: 'Arrived at port', arrived_warehouse: 'Arrived at warehouse', delayed: 'Delayed' } as Record<string, string>)[value] || value; }

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
