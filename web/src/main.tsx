import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@bryntum/gantt/stockholm-light.css';
import './style.css';
import { chargeWindow, localIsoDate } from './dates';

const BryntumGantt = lazy(async () => ({ default: (await import('@bryntum/gantt-react')).BryntumGantt }));

type Config = { missing: string[]; bryntumLicense: string | null; cardEntry?: boolean; demoSlug?: string | null };
type Campaign = { id: string; slug: string; name: string; description?: string | null; imageUrl: string | null; priceCents: number; currency: string; quantity: number; available?: number; reserved?: number; shipDate: string; chargeWindowDays: number };
type Wave = { id: string; number: number; units: number; shipDate: string; dateOverride?: string | null };
type Reservation = { id: string; email?: string; qty: number; position: number; status: string; waveId?: string | null; captureId?: string | null; orderId?: string | null; issue?: string | null; trackingNumber?: string | null; carrier?: string | null; capturedAt?: string | null; refundId?: string | null; outsideWindow?: boolean };
type SupplyUpdate = { id: string; units: number; milestone: string; date: string; origin: string | null; destination: string | null; vesselOrCarrier: string | null; quotes: string[]; confidence: number; confirmedAt: string };
type Desk = { campaign: Campaign; reserved: number; available: number; waves: Wave[]; allocations: { reservationId: string; waveId: string; qty: number }[]; reservations: Reservation[]; updates: SupplyUpdate[]; tasks: Task[]; dependencies: { fromTask: string; toTask: string }[] };
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
  return <Shell><Setup config={config} />{page}</Shell>;
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
    <div className="setup-intro"><p className="kicker">MERCHANT SHIPPING PLAN</p><h1>Take preorders before your stock is ready.</h1><p className="lede">Buyers save PayPal at reservation. Confirm production and freight as they happen, then charge each wave when it is ready to ship.</p><div className="intro-note"><span className="note-rule" /><p>One plan connects reservations, incoming supply, ship dates, and PayPal charges.</p></div></div>
    {featured ? <section className="featured-campaign" aria-labelledby="featured-title"><a className="featured-photo" href={`/p/${encodeURIComponent(featured.slug)}`} aria-label={`Open ${featured.name} campaign`}>{featured.imageUrl && <img src={featured.imageUrl} alt="" />}</a><div className="featured-copy"><p className="kicker">FEATURED CAMPAIGN</p><h2 id="featured-title">{featured.name}</h2><p>{money(featured.priceCents, featured.currency)} per unit <span>·</span> Ships {dateLabel(featured.shipDate)}</p></div><a className="button primary" href={`/p/${encodeURIComponent(featured.slug)}`}>View campaign</a></section> : featuredError && <p className="inline-error" role="alert">{featuredError}</p>}
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
    <form className="campaign-form panel" onSubmit={submit}>
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
  const load = useCallback(async () => { try { setDesk(await api<Desk>(`/api/campaigns/${encodeURIComponent(slug)}/desk`)); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The campaign could not be loaded.'); } }, [slug]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.addEventListener('update', event => { try { if ((JSON.parse((event as MessageEvent).data) as { slug: string }).slug === slug) void load(); } catch { /* Ignore malformed server events; the next event refreshes the page. */ } });
    return () => events.close();
  }, [slug, load]);
  const campaign = desk?.campaign;
  const stats = useMemo(() => desk ? ({ reserved: desk.reserved, waves: desk.waves.length, shipped: desk.reservations.filter(r => r.status === 'SHIPPED').length }) : null, [desk]);
  const displayTasks = useMemo(() => desk?.tasks.map(waveTask => ({ ...waveTask, children: waveTask.children?.map(task => task.id.endsWith('-charge') ? desk.reservations.some(r => r.waveId === waveTask.id && r.outsideWindow) ? { ...task, name: 'Charged too early: refund due', eventColor: '#c92a2a' } : { ...task, eventColor: chargeWindow(desk.waves.find(wave => wave.id === waveTask.id)?.shipDate || '', campaign?.chargeWindowDays || 0).eligible ? '#e8590c' : '#b7c2c6' } : task) })), [desk, campaign?.chargeWindowDays]);
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
      const result = await api<{ explanation: string | null }>(`/api/campaigns/${encodeURIComponent(slug)}/supply/confirm`, json('POST', {
        source, units, milestone: extraction.milestone, date, origin: String(form.get('origin') || '').trim() || null, destination: String(form.get('destination') || '').trim() || null, vesselOrCarrier: String(form.get('vesselOrCarrier') || '').trim() || null, quotes: extraction.quotes, confidence: extraction.confidence,
      }));
      setNotice('Supply update confirmed. Shipping waves have been replanned.'); setExplain(result.explanation || ''); setExtraction(null); setSource(''); setFile(null); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Supply update could not be confirmed.'); }
    finally { setBusy(''); }
  }
  async function charge(wave: Wave) {
    setBusy(`charge:${wave.id}`); setError(''); setNotice('');
    try {
      const result = await api<{ results: { id: string; status: string; captureId?: string; issue?: string; error?: string }[] }>(`/api/campaigns/${encodeURIComponent(slug)}/waves/${wave.id}/charge`, { method: 'POST' });
      setNotice(`Charge run finished. ${result.results.filter(r => r.status === 'CHARGED').length} completed, ${result.results.filter(r => r.status === 'DECLINED').length} declined.`); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Wave could not be charged.'); }
    finally { setBusy(''); }
  }
  async function refund(wave: Wave) {
    setBusy(`refund:${wave.id}`); setError(''); setNotice('');
    try {
      const result = await api<{ results: { status: string; refundId?: string; issue?: string; error?: string }[] }>(`/api/campaigns/${encodeURIComponent(slug)}/waves/${wave.id}/refund`, { method: 'POST' });
      const done = result.results.filter(r => r.status === 'REFUNDED');
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
  async function moveShipDate(taskRecords: { id: string; startDate?: Date }[]) {
    const task = taskRecords.find(record => desk?.waves.some(w => `${w.id}-ship` === record.id));
    if (!task?.startDate || !desk) return;
    const waveId = task.id.slice(0, -5); setBusy(`date:${waveId}`); setError('');
    try { await api(`/api/campaigns/${encodeURIComponent(slug)}/waves/${waveId}/date`, json('POST', { shipDate: localIsoDate(task.startDate) })); setNotice('Ship date moved. Charge eligibility has been recalculated.'); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Ship date could not be moved.'); await load(); }
    finally { setBusy(''); }
  }
  if (error && !desk) return <div className="page-state error-state" role="alert"><h1>Campaign unavailable</h1><p>{error}</p><a href="/">Create a campaign</a></div>;
  if (!desk || !campaign) return <div className="page-state" role="status">Loading campaign plan…</div>;
  return <section className="merchant-page">
    <div className="merchant-title"><div className="merchant-product"><div className="merchant-product-thumb">{campaign.imageUrl ? <img src={campaign.imageUrl} alt="" /> : <span aria-hidden="true">{campaign.name.slice(0, 1)}</span>}</div><div><p className="kicker">MERCHANT PLAN / <span>{slug}</span></p><h1>{campaign.name}</h1><p className="lede compact">Reservations, incoming supply, and the next charge dates.</p></div></div><a className="button quiet" href={`/p/${encodeURIComponent(slug)}`} target="_blank" rel="noreferrer">Open buyer page <span aria-hidden="true">↗</span></a></div>
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="inline-success" role="status">{notice}</p>}{explain && <p className="plan-explanation">{explain}</p>}
    <div className="workbench-head"><div className="campaign-facts"><div><span>AVAILABLE</span><strong className="mono">{desk.available} <small>UNITS</small></strong></div><div><span>RESERVED</span><strong className="mono">{stats?.reserved} <small>UNITS</small></strong></div><div><span>UNIT PRICE</span><strong className="mono">{money(campaign.priceCents, campaign.currency)}</strong></div><div><span>CHARGE WINDOW</span><strong className="mono">{campaign.chargeWindowDays} DAYS</strong></div></div><a className="copy-link" href={`/p/${encodeURIComponent(slug)}`}>BUYER LINK <span className="mono">/p/{slug}</span></a></div>
    <section className="timeline-section" aria-labelledby="timeline-title"><div className="section-heading timeline-heading"><div><p className="kicker">LIVE SHIPPING PLAN</p><h2 id="timeline-title">Waves and milestones</h2></div><div className="legend"><span><i className="dot production" /> Production</span><span><i className="dot freight" /> Freight and warehouse</span><span><i className="dot charge" /> Charge window</span><span><i className="dot shipped" /> Ship</span></div></div>
      {desk.tasks.length ? <div className="gantt-frame" style={{ height: Math.min(580, 96 + 48 * desk.tasks.reduce((rows, task) => rows + 1 + (task.children?.length || 0), 0)) }}><Suspense fallback={<div className="page-state" role="status">Loading shipping timeline…</div>}><BryntumGantt ariaLabel="Campaign shipping plan" tasks={displayTasks as never[]} dependencies={desk.dependencies as never[]} startDate={new Date(Math.min(...desk.waves.map(w => Date.parse(`${w.shipDate}T00:00:00Z`))) - 45 * 86_400_000)} endDate={new Date(Math.max(...desk.waves.map(w => Date.parse(`${w.shipDate}T00:00:00Z`))) + 45 * 86_400_000)} viewPreset="weekAndDayLetter" projectLinesFeature={false} subGridConfigs={{ locked: { width: window.innerWidth < 700 ? 170 : 436 } }} onPaint={({ source, firstPaint }) => { if (firstPaint) (source as unknown as { zoomToFit: (options: object) => void }).zoomToFit({ leftMargin: 24, rightMargin: 24 }); }} rowHeight={48} barMargin={9} columns={[{ type: 'name', field: 'name', text: 'WAVE / MILESTONE', width: 220 }, { type: 'startdate', text: 'START', width: 108 }, { type: 'enddate', text: 'FINISH', width: 108 }]} onTaskDrop={event => { void moveShipDate(event.taskRecords.map(record => ({ id: String(record.id), startDate: record.startDate ? new Date(String(record.startDate)) : undefined }))); }} /></Suspense>{busy.startsWith('date:') && <span className="gantt-saving" role="status">Saving revised ship date…</span>}</div> : <div className="empty-plan"><div><p className="kicker">AWAITING CONFIRMED SUPPLY</p><h3>Confirm your first supply update to plan waves.</h3><p>Paste a forwarder or production update below. The planner allocates confirmed units to reservations in order.</p></div></div>}
      <p className="timeline-hint">Drag a <strong>Ship</strong> bar to replan its wave. Orange marks the merchant-configured charge window.</p>
    </section>
    <div className="operations-grid"><section className="supply-section panel" aria-labelledby="supply-title"><div className="section-heading"><div><p className="kicker">SUPPLY IN</p><h2 id="supply-title">Update from a supplier</h2></div><span className="section-index">01</span></div><label htmlFor="supply-source">Paste an email, or attach a packing list or freight document</label><textarea id="supply-source" rows={7} value={source} onChange={e => setSource(e.target.value)} placeholder="Paste the factory or forwarder update here…" /><div className="supply-actions"><label className="file-pick">Attach PDF or photo<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={e => setFile(e.target.files?.[0] || null)} /></label>{file && <span className="file-name">{file.name}</span>}<button className="button secondary" onClick={() => { void extract(); }} disabled={busy === 'extract' || (!source.trim() && !file)}>{busy === 'extract' ? 'Reading source…' : 'Read update'}</button></div><p className="help-copy">AI extracts dates and quantities only when the source supports them. Every field stays linked to its quoted sentence.</p>
      {extraction && <form className="extraction" onSubmit={confirmSupply}><div className="extraction-heading"><div><p className="kicker">SOURCE CHECK</p><h3>Review extracted details</h3></div><span className="source-name">{sourceLabel}</span></div><label>Units <span className="mono">{extraction.field_quotes.units ? `“${extraction.field_quotes.units}”` : 'No source quote'}</span><input name="units" type="number" min="1" required defaultValue={extraction.units ?? ''} /></label><div className="field-grid"><label>Milestone <span className="mono quote">“{extraction.field_quotes.milestone}”</span><select value={extraction.milestone} onChange={e => setExtraction({ ...extraction, milestone: e.target.value })}><option value="production_complete">Production complete</option><option value="departed">Departed</option><option value="arrived_port">Arrived at port</option><option value="arrived_warehouse">Arrived at warehouse</option><option value="delayed">Delayed</option></select></label><label>Event date <span className="mono quote">{extraction.field_quotes.date ? `“${extraction.field_quotes.date}”` : extraction.eta ? `“${extraction.field_quotes.eta}”` : 'No source quote'}</span><input name="date" type="date" required defaultValue={extraction.date || ''} /></label></div><div className="field-grid"><label>Origin <span className="mono quote">{extraction.field_quotes.origin ? `“${extraction.field_quotes.origin}”` : 'No source quote'}</span><input name="origin" defaultValue={extraction.origin || ''} /></label><label>Destination <span className="mono quote">{extraction.field_quotes.destination ? `“${extraction.field_quotes.destination}”` : 'No source quote'}</span><input name="destination" defaultValue={extraction.destination || ''} /></label></div><label>Vessel or carrier <span className="mono quote">{extraction.field_quotes.vessel_or_carrier ? `“${extraction.field_quotes.vessel_or_carrier}”` : 'No source quote'}</span><input name="vesselOrCarrier" defaultValue={extraction.vessel_or_carrier || ''} /></label><p className="quote-list"><strong>Source sentences</strong>{extraction.quotes.map((quote, i) => <q key={`${i}-${quote}`}>{quote}</q>)}</p><p className="confidence mono">Confidence {(extraction.confidence * 100).toFixed(0)}%</p><button className="button primary" disabled={busy === 'confirm'}>{busy === 'confirm' ? 'Confirming and replanning…' : 'Confirm update and replan'}</button></form>}
    </section>
    <section className="wave-section" aria-labelledby="wave-title"><div className="section-heading"><div><p className="kicker">PLAN OUT</p><h2 id="wave-title">Wave actions</h2></div><span className="section-index">02</span></div>{desk.waves.length ? <div className="wave-list">{desk.waves.map(wave => { const window = chargeWindow(wave.shipDate, campaign.chargeWindowDays); const rows = desk.reservations.filter(r => r.waveId === wave.id); const chargeable = rows.filter(r => ['RESERVED', 'DECLINED', 'CHARGE_PENDING'].includes(r.status)); const canShip = rows.filter(r => ['CHARGED', 'SHIPPED'].includes(r.status) && !r.outsideWindow); const late = rows.filter(r => r.outsideWindow); return <article className="wave-card" key={wave.id}><div className="wave-card-head"><div><p className="kicker">WAVE {String(wave.number).padStart(2, '0')}</p><h3>{wave.units} <span>UNITS</span></h3></div><time className="mono" dateTime={wave.shipDate}>{dateLabel(wave.shipDate, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}</time></div><p className="wave-detail">{rows.length} reservations <span>·</span> {rows.filter(r => r.status === 'SHIPPED').length} shipped</p><button className={`button ${window.eligible ? 'charge-button' : 'secondary'}`} disabled={!window.eligible || !chargeable.length || Boolean(busy)} title={window.closed ? `The charge window closed on ${dateLabel(wave.shipDate)}.` : !window.eligible ? `Charging opens ${dateLabel(window.opens)}.` : undefined} onClick={() => { void charge(wave); }}>{busy === `charge:${wave.id}` ? 'Charging each reservation…' : `Charge Wave ${wave.number} (${chargeable.length} ${chargeable.length === 1 ? 'reservation' : 'reservations'})`}</button>{window.closed && <p className="disabled-reason">The charge window closed on {dateLabel(wave.shipDate)}. Drag the Ship bar to a new date to reopen it.</p>}{!window.eligible && !window.closed && <p className="disabled-reason">Charging opens {dateLabel(window.opens)}. The window runs through ship day.</p>}{window.eligible && !chargeable.length && <p className="disabled-reason">No reserved or retryable payments in this wave.</p>}{late.length > 0 && <div className="refund-due" role="status"><p><strong>{late.length} charged {late.length === 1 ? 'order ships' : 'orders ship'} {Math.round((Date.parse(`${wave.shipDate}T00:00:00Z`) - Date.parse(`${late[0]!.capturedAt!.slice(0, 10)}T00:00:00Z`)) / 86_400_000)} days after the charge.</strong> That is past the {campaign.chargeWindowDays} day window. Refund now and Shipday charges the same saved PayPal again when the new window opens.</p><button className="button refund-button" disabled={Boolean(busy)} onClick={() => { void refund(wave); }}>{busy === `refund:${wave.id}` ? 'Refunding through PayPal…' : `Refund ${late.length} and hold for ${dateLabel(wave.shipDate, { day: 'numeric', month: 'short', timeZone: 'UTC' })}`}</button></div>}
        {rows.length > 0 && <div className="reservation-list"><h4>RESERVATIONS</h4>{rows.map(row => <div className="reservation-row" key={row.id}><div className="reservation-main"><span className="mono">#{row.position} · {row.qty} {row.qty === 1 ? 'unit' : 'units'}</span><strong className={`status status-${row.status.toLowerCase()}`}>{statusLabel(row.status)}</strong></div>{row.captureId && <p className="proof mono">Capture {row.captureId}</p>}{row.refundId && !row.captureId && <p className="proof mono">Refund {row.refundId} · still reserved</p>}{row.outsideWindow && <p className="row-issue">Charged {dateLabel(row.capturedAt!, { day: 'numeric', month: 'short', timeZone: 'UTC' })}, now ships outside the window.</p>}{row.issue && <p className="row-issue">PayPal declined: {row.issue}</p>}{row.status === 'CHARGE_PENDING' && <p className="row-issue">PayPal has not confirmed a final capture yet.</p>}{row.status === 'SHIPPED' && <p className="proof mono">Tracking {row.carrier} · {row.trackingNumber}</p>}</div>)}</div>}
        {canShip.some(r => !r.trackingNumber) && <div className="dispatch-read"><h4>READ DISPATCH CONFIRMATION</h4><label className="visually-hidden" htmlFor={`dispatch-${wave.id}`}>Carrier or warehouse dispatch confirmation for wave {wave.number}</label><textarea id={`dispatch-${wave.id}`} rows={4} value={dispatch[wave.id] || ''} onChange={e => setDispatch({ ...dispatch, [wave.id]: e.target.value })} placeholder="Paste the carrier or 3PL dispatch email" /><button className="button secondary" disabled={!(dispatch[wave.id] || '').trim() || Boolean(busy)} onClick={() => { void readTracking(wave); }}>{busy === `read:${wave.id}` ? 'Reading parcels…' : 'Read tracking numbers'}</button></div>}
        {canShip.length > 0 && <div className="tracking-form"><h4>MARK SHIPPED</h4>{canShip.filter(r => !r.trackingNumber).map(row => <div className="tracking-row" key={row.id}><span className="mono">#{row.position}</span><label className="visually-hidden" htmlFor={`carrier-${row.id}`}>Carrier for reservation {row.position}</label><select id={`carrier-${row.id}`} value={tracking[row.id]?.carrier || ''} onChange={e => setTracking({ ...tracking, [row.id]: { ...tracking[row.id], number: tracking[row.id]?.number || '', carrier: e.target.value } })}><option value="">Carrier</option>{['USPS', 'UPS', 'FEDEX', 'DHL', 'ONTRAC'].map(value => <option key={value}>{value}</option>)}</select><label className="visually-hidden" htmlFor={`tracking-${row.id}`}>Tracking number for reservation {row.position}</label><input id={`tracking-${row.id}`} value={tracking[row.id]?.number || ''} onChange={e => setTracking({ ...tracking, [row.id]: { ...tracking[row.id], number: e.target.value, carrier: tracking[row.id]?.carrier || '' } })} placeholder="Tracking number" />{tracking[row.id]?.quote && <p className="proof tracking-quote">“{tracking[row.id]!.quote}”</p>}</div>)}<button className="button secondary" disabled={!canShip.some(r => tracking[r.id]?.number && tracking[r.id]?.carrier) || Boolean(busy)} onClick={() => { void saveTracking(wave); }}>{busy === `tracking:${wave.id}` ? 'Saving tracking…' : 'Save tracking and mark shipped'}</button></div>}
      </article>; })}</div> : <div className="empty-wave"><p>Waves appear after a supply update is confirmed and reservation units are allocated.</p></div>}</section></div>
    {desk.updates.length > 0 && <section className="updates-section"><div className="section-heading"><div><p className="kicker">CONFIRMED SOURCE RECORD</p><h2>Supply history</h2></div></div><ol className="update-list">{desk.updates.map(update => <li key={update.id}><time className="mono">{dateLabel(update.date, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}</time><div><strong>{update.units} units · {milestoneLabel(update.milestone)}</strong><p>{update.quotes.map((quote, i) => <React.Fragment key={i}>{i > 0 && ' '}<q>{quote}</q></React.Fragment>)}</p></div></li>)}</ol></section>}
    {config?.bryntumLicense && <span className="sr-only">Bryntum Gantt license configured.</span>}
  </section>;
}

function Buyer({ slug, cardEntry }: { slug: string; cardEntry: boolean }) {
  const [campaign, setCampaign] = useState<CampaignPublic | null>(null); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
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
  return <section className="buyer-page"><div className="buyer-label"><span>SHIPDAY RESERVATION</span><span>Check order status from your saved reservation link.</span></div><div className="buyer-layout"><div className="product-image">{campaign.imageUrl ? <img src={campaign.imageUrl} alt={campaign.name} /> : <div className="product-image-fallback"><span>PRODUCT</span><strong>{campaign.name.slice(0, 1)}</strong><b>{campaign.name}</b></div>}</div><div className="buyer-copy"><h1>{campaign.name}</h1>{campaign.description && <p className="buyer-description">{campaign.description}</p>}<p className="buyer-price">{money(campaign.priceCents, campaign.currency)} <span>per unit</span></p><p className="ship-date-label">Estimated ship date</p><time className="buyer-date" dateTime={date}>{dateLabel(date, { day: 'numeric', month: 'long', timeZone: 'UTC' })}</time><p className="buyer-promise">Charged only when your wave is ready to ship.</p><p className="buyer-sentence">Reserve your unit today. Your PayPal is charged when your shipping wave is ready, never at reservation.</p><form className="reserve-form" onSubmit={reserve}><label>Email for your reservation<input name="email" type="email" autoComplete="email" required placeholder="you@example.com" /></label><label>Units<input name="qty" type="number" min="1" max={Math.min(100, campaign.available || 0)} defaultValue="1" required /></label><button className="button primary reserve-button" disabled={saving || campaign.available === 0}>{saving ? 'Opening PayPal…' : 'Save PayPal. Pay when it ships.'}</button>{error && <p role="alert" className="inline-error">{error}</p>}<p className="charge-copy">Nothing is charged today. We charge your PayPal within the {campaign.chargeWindowDays}-day window before shipping, currently planned for {dateLabel(date)}.</p></form>{cardEntry && <details className="card-reserve"><summary>Reserve with a card instead</summary><form className="reserve-form" onSubmit={reserveCard}><label>Email for your reservation<input name="email" type="email" autoComplete="email" required placeholder="you@example.com" /></label><label>Units<input name="qty" type="number" min="1" max={Math.min(100, campaign.available || 0)} defaultValue="1" required /></label><label>Name on card<input name="cardName" autoComplete="cc-name" required minLength={2} /></label><label>Card number<input name="cardNumber" inputMode="numeric" autoComplete="cc-number" required pattern="[0-9 ]{12,23}" /></label><div className="field-grid"><label>Expiry<input name="cardExpiry" type="month" autoComplete="cc-exp" required /></label><label>Security code<input name="cardCode" inputMode="numeric" autoComplete="cc-csc" required pattern="[0-9]{3,4}" /></label></div><button className="button primary reserve-button" disabled={saving || campaign.available === 0}>{saving ? 'Saving card with PayPal…' : 'Save card. Pay when it ships.'}</button><p className="charge-copy">PayPal saves the card in its vault. Nothing is charged today.</p></form></details>}<p className="availability mono">{campaign.available} UNITS AVAILABLE <span>·</span> {money(campaign.priceCents, campaign.currency)} EACH</p><aside className="money-rule"><strong>Your payment is saved securely with PayPal.</strong><p>Shipday does not charge when you reserve. You can cancel any time before a charge begins.</p></aside><details className="policy-note"><summary>PayPal pre-order shipping policy</summary><p>{campaign.policy.quote}</p><a href={campaign.policy.url} target="_blank" rel="noreferrer">Read PayPal Seller Protection</a><small>Checked {campaign.policy.checkedAt}. This is a Seller Protection condition, not a universal charge timing rule.</small></details></div></div></section>;
}

function ReservationPage({ id }: { id: string }) {
  const [reservation, setReservation] = useState<{ id: string; qty: number; position: number; status: string; captureId: string | null; issue: string | null; campaignName: string; imageUrl: string | null; shipDate: string; chargeWindowDays: number; currency: string; amountCents: number; canCancel: boolean; refund: { refundId: string; reason: string; refundedAt: string } | null } | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<typeof reservation>(`/api/reservations/${encodeURIComponent(id)}`).then(value => setReservation(value)).catch(cause => setError(cause instanceof Error ? cause.message : 'Reservation not found.')), [id]);
  useEffect(() => { void load(); }, [load]);
  async function cancel() { setBusy(true); setError(''); try { await api(`/api/reservations/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); setNotice('Reservation cancelled. The saved PayPal payment token was removed.'); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Reservation could not be cancelled.'); } finally { setBusy(false); } }
  if (error && !reservation) return <div className="page-state error-state" role="alert"><h1>Reservation unavailable</h1><p>{error}</p></div>;
  if (!reservation) return <div className="page-state" role="status">Loading reservation…</div>;
  const status = statusLabel(reservation.status);
  const refunded = reservation.refund && ['RESERVED', 'CHARGE_PENDING', 'DECLINED'].includes(reservation.status) ? reservation.refund : null;
  return <section className="receipt-page"><div className="receipt-mark">SHIPDAY <span>PLAN POSITION {reservation.position}</span></div>{reservation.imageUrl && <img className="receipt-product-image" src={reservation.imageUrl} alt={reservation.campaignName} />}{new URLSearchParams(window.location.search).get('paypal') === 'reserved' && <p className="inline-success" role="status">Saved. Not charged yet.</p>}{notice && <p className="inline-success" role="status">{notice}</p>}{error && <p className="inline-error" role="alert">{error}</p>}<p className="kicker">{reservation.campaignName}</p><h1>{refunded ? 'Refunded. Still reserved.' : reservation.status === 'CHARGED' ? 'Charged today.' : reservation.status === 'SHIPPED' ? 'Shipping update.' : reservation.status === 'CANCELLED' ? 'Reservation cancelled.' : reservation.status === 'PENDING' ? 'Finish saving PayPal.' : 'Your reservation is saved.'}</h1><time className="receipt-date" dateTime={reservation.shipDate}>{dateLabel(reservation.shipDate, { day: 'numeric', month: 'long', timeZone: 'UTC' })}</time><p className="receipt-sentence">{refunded ? `${refunded.reason} Shipday refunded your PayPal in full and will charge it again within ${reservation.chargeWindowDays} days of the new ship date.` : reservation.status === 'CHARGED' ? 'Your PayPal payment is complete. Your unit ships on the date above.' : reservation.status === 'SHIPPED' ? 'Your order is on its way.' : reservation.status === 'CANCELLED' ? 'No payment will be collected for this reservation.' : reservation.status === 'PENDING' ? 'PayPal has not confirmed your saved payment yet. Nothing is charged until your shipping wave is ready.' : `Your order is in the shipping plan. We charge your PayPal within ${reservation.chargeWindowDays} days of shipping.`}</p><dl className="receipt-facts"><div><dt>STATUS</dt><dd className="status">{status}</dd></div><div><dt>QUANTITY</dt><dd className="mono">{reservation.qty} {reservation.qty === 1 ? 'unit' : 'units'}</dd></div><div><dt>AMOUNT WHEN CHARGED</dt><dd className="mono">{money(reservation.amountCents, reservation.currency)}</dd></div>{reservation.captureId && <div><dt>PAYPAL CAPTURE</dt><dd className="mono capture-id">{reservation.captureId}</dd></div>}{refunded && <div><dt>PAYPAL REFUND</dt><dd className="mono capture-id">{refunded.refundId}</dd></div>}</dl>{reservation.issue && <p className="row-issue">PayPal response: {reservation.issue}</p>}{reservation.canCancel && <button className="button secondary" disabled={busy} onClick={() => { void cancel(); }}>{busy ? 'Cancelling…' : 'Cancel reservation'}</button>}<p className="receipt-foot">Save this page to check the current plan. Reservation reference <span className="mono">{reservation.id}</span></p></section>;
}

function statusLabel(status: string) { return ({ RESERVED: 'Reserved', PENDING: 'PayPal approval pending', CANCEL_PENDING: 'Cancelling', CANCELLED: 'Cancelled', CHARGE_PENDING: 'Charge pending', DECLINED: 'Payment declined', CHARGED: 'Charged', SHIPPED: 'Shipped' } as Record<string, string>)[status] || status; }
function milestoneLabel(value: string) { return ({ production_complete: 'Production complete', departed: 'Departed', arrived_port: 'Arrived at port', arrived_warehouse: 'Arrived at warehouse', delayed: 'Delayed' } as Record<string, string>)[value] || value; }

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
