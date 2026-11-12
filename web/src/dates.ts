// Bryntum reads 'YYYY-MM-DD' as local midnight, so a dropped date must be read back from local fields.
export function localIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
