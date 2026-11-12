import { z } from 'zod';
import { carriers, milestones } from './domain.js';

const nullableQuote = z.string().min(1).nullable();
export const SupplyExtractionSchema = z.object({
  units: z.number().int().min(1).nullable(),
  milestone: z.enum(milestones),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  eta: z.string().min(1).nullable(),
  origin: z.string().min(1).nullable(),
  destination: z.string().min(1).nullable(),
  vessel_or_carrier: z.string().min(1).nullable(),
  quotes: z.array(z.string().min(1)).min(1),
  field_quotes: z.object({
    units: nullableQuote, milestone: z.string().min(1), date: nullableQuote, eta: nullableQuote,
    origin: nullableQuote, destination: nullableQuote, vessel_or_carrier: nullableQuote,
  }),
  confidence: z.number().min(0).max(1),
}).superRefine((v, ctx) => {
  if (v.date === null && v.eta === null) ctx.addIssue({ code: 'custom', path: ['date'], message: 'Provide a source date or ETA.' });
  if ((v.units === null) !== (v.field_quotes.units === null)) ctx.addIssue({ code: 'custom', path: ['field_quotes', 'units'], message: 'Units and its quote must both be present or absent.' });
  for (const [field, quote] of Object.entries(v.field_quotes)) {
    if (quote && !v.quotes.some(sentence => sentence.includes(quote))) ctx.addIssue({ code: 'custom', path: ['field_quotes', field], message: 'Field quote must come from one of the quoted sentences.' });
  }
});

export type SupplyExtraction = z.infer<typeof SupplyExtractionSchema>;
export class AIError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'AIError'; }
}

const schema = {
  type: 'object', additionalProperties: false,
  required: ['units', 'milestone', 'date', 'eta', 'origin', 'destination', 'vessel_or_carrier', 'quotes', 'field_quotes', 'confidence'],
  properties: {
    units: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    milestone: { type: 'string', enum: [...milestones] },
    date: { anyOf: [{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' }] },
    eta: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    origin: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    destination: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    vessel_or_carrier: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    quotes: { type: 'array', items: { type: 'string' }, minItems: 1 },
    field_quotes: {
      type: 'object', additionalProperties: false,
      required: ['units', 'milestone', 'date', 'eta', 'origin', 'destination', 'vessel_or_carrier'],
      properties: Object.fromEntries(['units', 'milestone', 'date', 'eta', 'origin', 'destination', 'vessel_or_carrier'].map(k => [k, { anyOf: [{ type: 'string' }, { type: 'null' }] }])),
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

type InputPart = { type: 'image_url'; image_url: { url: string } } | { type: 'file'; file: { filename: string; file_data: string } };

export async function extractSupply(input: { text: string; file?: { name: string; mime: string; bytes: Uint8Array } }): Promise<SupplyExtraction> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new AIError('Supply understanding is not configured. Set OPENROUTER_API_KEY.');
  const model = process.env.AI_MODEL || 'google/gemini-2.5-flash';
  const parts: (InputPart | { type: 'text'; text: string })[] = [{
    type: 'text',
    text: `Extract one supply update from the provided source. Return only facts supported by the source. Do not infer missing quantities, places, dates, or milestones. A date must be YYYY-MM-DD. Today is ${new Date().toISOString().slice(0, 10)}; when the source gives a day and month without a year, use the year that puts the date closest to today. If the source gives a relative or unclear ETA, put it in eta and set date null. Copy exact complete source sentences into quotes and field_quotes. Use null for unsupported optional values and for unsupported units. Every non-null field_quote must be an exact excerpt of one of the quotes.\n\nSource text:\n${input.text || '(See attached file.)'}`,
  }];
  if (input.file) {
    const data = Buffer.from(input.file.bytes).toString('base64');
    if (input.file.mime === 'application/pdf') parts.push({ type: 'file', file: { filename: input.file.name, file_data: `data:application/pdf;base64,${data}` } });
    else parts.push({ type: 'image_url', image_url: { url: `data:${input.file.mime};base64,${data}` } });
  }
  return callValidated(key, model, parts, 'shipday_supply_update', schema, raw => parseSupplyExtraction(raw, input.text));
}

export async function explainPlan(data: unknown): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new AIError('Plan explanations are not configured. Set OPENROUTER_API_KEY.');
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Shipday' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ model: process.env.AI_MODEL || 'google/gemini-2.5-flash', temperature: 0,
      messages: [
        { role: 'system', content: 'Explain the schedule using only the supplied confirmed dates, milestones, and quotes. Do not add causes or facts. One plain sentence.' },
        { role: 'user', content: JSON.stringify(data) },
      ], response_format: { type: 'json_schema', json_schema: { name: 'plan_explanation', strict: true, schema: { type: 'object', additionalProperties: false, required: ['explanation'], properties: { explanation: { type: 'string' } } } } },
    }),
  });
  if (!response.ok) throw new AIError(`OpenRouter returned HTTP ${response.status}.`, response.status);
  const body = await response.json() as { choices?: { message?: { content?: unknown } }[] };
  try {
    const parsed = z.object({ explanation: z.string().min(1) }).parse(JSON.parse(String(body.choices?.[0]?.message?.content ?? '')));
    return parsed.explanation;
  } catch { throw new AIError('OpenRouter returned an invalid plan explanation.'); }
}

async function callValidated<T>(key: string, model: string, parts: unknown[], name: string, jsonSchema: unknown, parse: (raw: string) => T): Promise<T> {
  let correction = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Shipday' },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({ model, temperature: 0, messages: [
        { role: 'system', content: 'Extract evidence from supply-chain documents. Never fill in a value that is absent.' },
        { role: 'user', content: [...parts, ...(correction ? [{ type: 'text', text: `Your last response failed validation: ${correction}. Return corrected JSON.` }] : [])] },
      ], response_format: { type: 'json_schema', json_schema: { name, strict: true, schema: jsonSchema } } }),
    });
    if (!response.ok) throw new AIError(`OpenRouter returned HTTP ${response.status}.`, response.status);
    const body = await response.json() as { choices?: { message?: { content?: unknown } }[] };
    try {
      return parse(String(body.choices?.[0]?.message?.content ?? ''));
    } catch (error) {
      correction = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : error instanceof Error ? error.message : String(error);
      if (attempt) throw new AIError(`Extraction could not be validated: ${correction}`);
    }
  }
  throw new AIError('Extraction could not be validated.');
}

export function parseSupplyExtraction(raw: string, sourceText = ''): SupplyExtraction {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('Output is not valid JSON.'); }
  const parsed = SupplyExtractionSchema.parse(value);
  if (sourceText && parsed.quotes.some(q => !sourceText.includes(q))) throw new Error('A quoted sentence was not found verbatim in the supplied text.');
  if (sourceText && Object.values(parsed.field_quotes).some(q => q !== null && !sourceText.includes(q))) throw new Error('A field quote was not found verbatim in the supplied text.');
  return parsed;
}

export const ShipmentExtractionSchema = z.object({ shipments: z.array(z.object({
  reference: z.string().min(1).nullable(), recipient_email: z.string().min(3).nullable(),
  carrier: z.enum(carriers).nullable(), tracking_number: z.string().trim().min(3).max(100), quote: z.string().min(1),
})).min(1) });

const shipmentSchema = {
  type: 'object', additionalProperties: false, required: ['shipments'],
  properties: { shipments: { type: 'array', minItems: 1, items: {
    type: 'object', additionalProperties: false, required: ['reference', 'recipient_email', 'carrier', 'tracking_number', 'quote'],
    properties: {
      reference: { anyOf: [{ type: 'string' }, { type: 'null' }] }, recipient_email: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      carrier: { anyOf: [{ type: 'string', enum: [...carriers] }, { type: 'null' }] }, tracking_number: { type: 'string' }, quote: { type: 'string' },
    },
  } } },
} as const;

export function parseShipmentExtraction(raw: string, sourceText: string) {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('Output is not valid JSON.'); }
  const parsed = ShipmentExtractionSchema.parse(value);
  for (const s of parsed.shipments) {
    if (!sourceText.includes(s.quote)) throw new Error('A shipment quote was not found verbatim in the supplied text.');
    if (!s.quote.includes(s.tracking_number)) throw new Error(`The tracking number ${s.tracking_number} is not in its quoted line.`);
  }
  return parsed;
}

export async function extractShipments(text: string) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new AIError('Shipment reading is not configured. Set OPENROUTER_API_KEY.');
  return callValidated(key, process.env.AI_MODEL || 'google/gemini-2.5-flash', [{ type: 'text', text: `List every outbound parcel in this carrier, 3PL, or warehouse dispatch confirmation. For each parcel return the order reference exactly as written (null if absent), the recipient email (null if absent), the carrier as one of ${carriers.join(', ')} (null if it is none of these or not stated), the tracking number exactly as written, and the exact complete source line that contains that tracking number as quote. Never invent a value.\n\nSource text:\n${text}` }], 'shipday_shipments', shipmentSchema, raw => parseShipmentExtraction(raw, text));
}
