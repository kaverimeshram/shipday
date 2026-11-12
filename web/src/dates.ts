// Bryntum reads 'YYYY-MM-DD' as local midnight, so a dropped date must be read back from local fields.
export function localIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function chargeWindow(shipDate: string, days: number, now = new Date()): { eligible: boolean; opens: string; closed: boolean } {
  const ship = Date.parse(`${shipDate}T00:00:00Z`);
  const opens = new Date(ship - days * 86_400_000).toISOString().slice(0, 10);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { eligible: today >= Date.parse(`${opens}T00:00:00Z`) && today <= ship, opens, closed: today > ship };
}
