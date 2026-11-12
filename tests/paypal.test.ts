import { describe, expect, it } from 'vitest';
import { orderHasTracker, vaultPaymentSource } from '../src/paypal.js';

describe('merchant-initiated payment source', () => {
  it('charges a card vault through payment_source.card', () => {
    expect(vaultPaymentSource('card', 'tok-card')).toEqual({ card: { vault_id: 'tok-card', stored_credential: { payment_initiator: 'MERCHANT', payment_type: 'UNSCHEDULED', usage: 'SUBSEQUENT' } } });
  });
  it('charges a PayPal wallet vault through payment_source.paypal', () => {
    expect(vaultPaymentSource('paypal', 'tok-wallet')).toEqual({ paypal: { vault_id: 'tok-wallet', stored_credential: { payment_initiator: 'MERCHANT', usage: 'SUBSEQUENT' } } });
  });
  it('refuses to build a charge without a vault id', () => {
    expect(() => vaultPaymentSource('card', '')).toThrow('saved payment token');
    expect(() => vaultPaymentSource('paypal', null)).toThrow('saved payment token');
  });
});

describe('tracker readback', () => {
  const order = { id: 'O', status: 'COMPLETED', purchase_units: [{ shipping: { trackers: [{ id: '21W073348X096610A-1Z999AA10123456784', status: 'SHIPPED' }] } }] };
  it('finds the tracker PayPal returns as capture id plus tracking number', () => {
    expect(orderHasTracker(order, '21W073348X096610A', '1Z999AA10123456784')).toBe(true);
  });
  it('does not accept a tracker for another parcel', () => {
    expect(orderHasTracker(order, '21W073348X096610A', '1Z999AA10000000000')).toBe(false);
  });
});
