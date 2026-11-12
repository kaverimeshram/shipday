import { describe, expect, it } from 'vitest';
import { parseShipmentExtraction, parseSupplyExtraction } from '../src/ai.js';

const source = 'The production run of 240 units is complete on 2026-11-12.';
const output = {
  units: 240, milestone: 'production_complete', date: '2026-11-12', eta: null,
  origin: null, destination: null, vessel_or_carrier: null,
  quotes: ['The production run of 240 units is complete on 2026-11-12.'],
  field_quotes: { units: 'The production run of 240 units is complete on 2026-11-12.', milestone: 'The production run of 240 units is complete on 2026-11-12.', date: 'The production run of 240 units is complete on 2026-11-12.', eta: null, origin: null, destination: null, vessel_or_carrier: null },
  confidence: 0.94,
};

describe('supply evidence validation', () => {
  it('accepts typed milestone data whose quotes occur in the source', () => {
    expect(parseSupplyExtraction(JSON.stringify(output), source).units).toBe(240);
  });

  it('rejects a quote that the source does not contain', () => {
    const fabricated = { ...output, quotes: ['A different sentence.'], field_quotes: { ...output.field_quotes, units: 'A different sentence.', milestone: 'A different sentence.', date: 'A different sentence.' } };
    expect(() => parseSupplyExtraction(JSON.stringify(fabricated), source)).toThrow('not found verbatim');
  });

  it('accepts a field quote that is a fragment of a quoted sentence', () => {
    const fragments = { ...output, field_quotes: { ...output.field_quotes, units: '240 units', date: '2026-11-12' } };
    expect(parseSupplyExtraction(JSON.stringify(fragments), source).field_quotes.units).toBe('240 units');
  });

  it('rejects a field quote that no quoted sentence contains', () => {
    const unlinked = { ...output, field_quotes: { ...output.field_quotes, units: 'production run' }, quotes: ['240 units is complete on 2026-11-12.'] };
    expect(() => parseSupplyExtraction(JSON.stringify(unlinked), source)).toThrow('Field quote must come from one of the quoted sentences');
  });

  it('rejects unsupported dates and missing evidence', () => {
    expect(() => parseSupplyExtraction(JSON.stringify({ ...output, date: 'next week', quotes: [] }))).toThrow();
  });
});

describe('shipment confirmation validation', () => {
  const dispatch = 'Order #1 for buyer@example.com left Reno via UPS, tracking 1Z999AA10123456784.';
  const shipment = { reference: '#1', recipient_email: 'buyer@example.com', carrier: 'UPS', tracking_number: '1Z999AA10123456784', quote: dispatch };

  it('accepts a shipment whose tracking number sits inside a verbatim source line', () => {
    expect(parseShipmentExtraction(JSON.stringify({ shipments: [shipment] }), dispatch).shipments[0]!.tracking_number).toBe('1Z999AA10123456784');
  });

  it('rejects a tracking number the source does not contain', () => {
    expect(() => parseShipmentExtraction(JSON.stringify({ shipments: [{ ...shipment, tracking_number: '1Z999AA10000000000' }] }), dispatch)).toThrow('tracking number');
  });
});
