export const milestones = ['production_complete', 'departed', 'arrived_port', 'arrived_warehouse', 'delayed'] as const;
export type Milestone = (typeof milestones)[number];

export type Reservation = { id: string; qty: number; position: number; status?: string; captureId?: string | null; waveId?: string | null; allocations?: Allocation[] };
export type Supply = { id: string; units: number; milestone: Milestone; eventDate: string };
export type Wave = { id: string; number: number; units: number; shipDate: string };
export type Allocation = { reservationId: string; waveId: string; qty: number };

export const leadDays: Record<Milestone, number> = {
  production_complete: 35,
  departed: 21,
  arrived_port: 10,
  arrived_warehouse: 2,
  delayed: 7,
};

export function planWaves(supplies: Supply[], reservations: Reservation[]) {
  const waves: Wave[] = [...supplies]
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.id.localeCompare(b.id))
    .map((s, i) => ({
      id: s.id,
      number: i + 1,
      units: s.units,
      shipDate: addDays(s.eventDate, leadDays[s.milestone]),
    }));
  const remaining = new Map(waves.map(w => [w.id, w.units]));
  const allocations: Allocation[] = [];
  for (const reservation of [...reservations].sort((a, b) => a.position - b.position)) {
    if (!Number.isInteger(reservation.qty) || reservation.qty < 1) throw new Error('Reservation quantity must be a positive integer');
    if (reservation.captureId || ['CHARGE_PENDING', 'CHARGED', 'SHIPPED'].includes(reservation.status || '')) {
      const pinned = reservation.allocations?.length
        ? reservation.allocations
        : reservation.waveId ? [{ reservationId: reservation.id, waveId: reservation.waveId, qty: reservation.qty }] : [];
      allocations.push(...pinned);
      continue;
    }
    let left = reservation.qty;
    for (const wave of waves) {
      const available = remaining.get(wave.id) ?? 0;
      const qty = Math.min(left, available);
      if (qty > 0) {
        allocations.push({ reservationId: reservation.id, waveId: wave.id, qty });
        remaining.set(wave.id, available - qty);
        left -= qty;
      }
      if (!left) break;
    }
  }
  return { waves, allocations };
}

export function isChargeEligible(shipDate: string, now: Date, windowDays: number): boolean {
  if (!Number.isInteger(windowDays) || windowDays < 0) throw new Error('Charge window must be a non-negative integer');
  const ship = dateMs(shipDate);
  const today = startOfDay(now).getTime();
  const opens = ship - windowDays * 86_400_000;
  return today >= opens && today <= ship;
}

export function outsideChargeWindow(capturedAt: string, shipDate: string, windowDays: number): boolean {
  return dateMs(shipDate) > dateMs(capturedAt.slice(0, 10)) + windowDays * 86_400_000;
}

export const carriers = ['USPS', 'UPS', 'FEDEX', 'DHL', 'ONTRAC'] as const;
export type Shipment = { reference: string | null; recipient_email: string | null; carrier: string | null; tracking_number: string; quote: string };

export function matchShipments(shipments: Shipment[], rows: { id: string; position: number; email: string }[]) {
  const used = new Set<string>();
  const matched: { reservationId: string; trackingNumber: string; carrier: string; quote: string }[] = [];
  const unmatched: Shipment[] = [];
  for (const shipment of shipments) {
    const ref = shipment.reference?.toLowerCase() || '';
    const email = shipment.recipient_email?.toLowerCase();
    const row = (carriers as readonly string[]).includes(shipment.carrier || '') ? rows.find(r => !used.has(r.id) && (
      (email && r.email.toLowerCase() === email) ||
      (ref && (ref.includes(r.id.slice(0, 8).toLowerCase()) || new RegExp(`#${r.position}(?!\\d)`).test(ref))))) : undefined;
    if (!row) { unmatched.push(shipment); continue; }
    used.add(row.id);
    matched.push({ reservationId: row.id, trackingNumber: shipment.tracking_number, carrier: shipment.carrier!, quote: shipment.quote });
  }
  return { matched, unmatched };
}

export function chargeRefusal(status: string, alreadyHasCapture: boolean): string | null {
  if (status === 'CHARGE_PENDING') return 'A charge attempt is already in progress.';
  if (alreadyHasCapture || status === 'CHARGED' || status === 'SHIPPED') return 'This reservation has already been charged.';
  if (!['RESERVED', 'DECLINED'].includes(status)) return `Reservation status ${status} cannot be charged.`;
  return null;
}

export function moveWave(waves: Wave[], id: string, shipDate: string): Wave[] {
  dateMs(shipDate);
  if (!waves.some(w => w.id === id)) throw new Error('Wave does not exist');
  return waves.map(w => w.id === id ? { ...w, shipDate } : w);
}

export function ganttTasks(waves: Wave[], chargeWindowDays: number) {
  return waves.flatMap(wave => {
    const ship = dateMs(wave.shipDate);
    const phase = (days: number) => new Date(ship - days * 86_400_000).toISOString().slice(0, 10);
    const ids = ['production', 'freight', 'warehouse', 'charge', 'ship'].map(x => `${wave.id}-${x}`);
    return [
      { id: wave.id, name: `Wave ${wave.number} · ${wave.units} units`, expanded: true, children: [
        { id: ids[0], name: 'Production', startDate: phase(35), endDate: phase(27), eventColor: '#8da4ad', manuallyScheduled: true },
        { id: ids[1], name: 'Freight', startDate: phase(27), endDate: phase(7), eventColor: '#557789', manuallyScheduled: true },
        { id: ids[2], name: 'Warehouse', startDate: phase(7), endDate: phase(2), eventColor: '#557789', manuallyScheduled: true },
        { id: ids[3], name: 'Charge window', startDate: phase(chargeWindowDays), endDate: wave.shipDate, eventColor: '#e8590c', manuallyScheduled: true },
        { id: ids[4], name: 'Ship', startDate: wave.shipDate, endDate: addDays(wave.shipDate, 1), eventColor: '#3c6b42', manuallyScheduled: true },
      ] },
    ];
  });
}

export function ganttDependencies(waves: Wave[]) {
  return waves.flatMap(wave => [['production', 'freight'], ['freight', 'warehouse'], ['warehouse', 'ship'], ['charge', 'ship']]
    .map(([from, to]) => ({ fromTask: `${wave.id}-${from}`, toTask: `${wave.id}-${to}` })));
}

export function canCancel(status: string): boolean {
  return ['PENDING', 'RESERVED'].includes(status);
}

function addDays(date: string, days: number): string {
  const d = new Date(dateMs(date));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateMs(date: string): number {
  const value = new Date(`${date}T00:00:00.000Z`).getTime();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) throw new Error('Invalid ship date');
  return value;
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
