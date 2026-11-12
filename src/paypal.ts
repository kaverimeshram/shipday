import { randomUUID } from 'node:crypto';

const base = process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
let cachedToken: { value: string; expiresAt: number } | undefined;

export class PayPalError extends Error {
  constructor(message: string, readonly status: number, readonly issue?: string, readonly debugId?: string) {
    super(message);
    this.name = 'PayPalError';
  }
}

export type PayPalOrder = {
  id: string;
  status: string;
  purchase_units?: { payments?: { captures?: { id: string; status: string; status_details?: { reason?: string } }[] }; shipping?: { trackers?: { tracking_number?: string }[] } }[];
  links?: { rel: string; href: string }[];
};

async function accessToken(): Promise<string> {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.');
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const response = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json() as { access_token?: string; expires_in?: number };
  if (!response.ok || !body.access_token) throw new PayPalError('PayPal OAuth failed.', response.status);
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
  return body.access_token;
}

async function request<T>(path: string, init: RequestInit = {}, requestId?: string): Promise<T> {
  const token = await accessToken();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { body = {}; }
  if (!response.ok) {
    const details = Array.isArray(body.details) ? body.details as { issue?: string }[] : [];
    const issue = details[0]?.issue ?? (typeof body.name === 'string' ? body.name : undefined);
    const debugId = response.headers.get('paypal-debug-id') ?? undefined;
    console.error('PayPal API error', { status: response.status, issue, debugId });
    throw new PayPalError(typeof body.message === 'string' ? body.message : 'PayPal request failed.', response.status, issue, debugId);
  }
  return body as T;
}

export const newRequestId = () => randomUUID();

export function createSetupToken(input: { campaignName: string; returnUrl: string; cancelUrl: string }, requestId: string) {
  return request<{ id: string; status: string; links?: { rel: string; href: string }[] }>('/v3/vault/setup-tokens', {
    method: 'POST',
    body: JSON.stringify({
      payment_source: { paypal: {
        description: `Reservation for ${input.campaignName}`,
        usage_type: 'MERCHANT', customer_type: 'CONSUMER', usage_pattern: 'DEFERRED',
        permit_multiple_payment_tokens: false,
        experience_context: { return_url: input.returnUrl, cancel_url: input.cancelUrl, brand_name: 'Shipday', shipping_preference: 'GET_FROM_FILE' },
      } },
    }),
  }, requestId);
}

export const createPaymentToken = (setupTokenId: string, requestId: string) => request<{
  id: string; customer?: { id?: string }; payment_source?: { paypal?: { email_address?: string } };
}>(
  '/v3/vault/payment-tokens', { method: 'POST', body: JSON.stringify({ payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } }) }, requestId,
);

export const getPaymentToken = (id: string) => request<{ id: string; customer?: { id?: string }; payment_source?: { paypal?: { email_address?: string } } }>(`/v3/vault/payment-tokens/${encodeURIComponent(id)}`);

export const deletePaymentToken = (id: string, requestId: string) => request<void>(`/v3/vault/payment-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }, requestId);

export const getPaymentTokenForCancelCheck = async (id: string): Promise<boolean> => {
  try { await getPaymentToken(id); return true; }
  catch (error) { if (error instanceof PayPalError && error.status === 404) return false; throw error; }
};

export function createVaultOrder(input: { vaultId: string; amount: string; currency: string; reservationId: string }, requestId: string) {
  return request<PayPalOrder>('/v2/checkout/orders', {
    method: 'POST',
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: input.reservationId, amount: { currency_code: input.currency, value: input.amount } }],
      payment_source: { paypal: { vault_id: input.vaultId, stored_credential: { payment_initiator: 'MERCHANT', usage: 'SUBSEQUENT' } } },
    }),
  }, requestId);
}

export const getOrder = (id: string) => request<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(id)}`);
export const captureOrder = (id: string, requestId: string) => request<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, { method: 'POST', body: '{}' }, requestId);

export type PayPalRefund = { id: string; status: string; status_details?: { reason?: string } };
export const refundCapture = (captureId: string, requestId: string) => request<PayPalRefund>(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, { method: 'POST', body: '{}' }, requestId);
export const getRefund = (id: string) => request<PayPalRefund>(`/v2/payments/refunds/${encodeURIComponent(id)}`);

export function addTracking(input: { orderId: string; captureId: string; trackingNumber: string; carrier: string }, requestId: string) {
  return request<void>(`/v2/checkout/orders/${encodeURIComponent(input.orderId)}/track`, {
    method: 'POST',
    body: JSON.stringify({ capture_id: input.captureId, tracking_number: input.trackingNumber, carrier: input.carrier, notify_payer: false }),
  }, requestId);
}

export function verifyWebhookSignature(input: Record<string, unknown>) {
  return request<{ verification_status: string }>('/v1/notifications/verify-webhook-signature', { method: 'POST', body: JSON.stringify(input) });
}
