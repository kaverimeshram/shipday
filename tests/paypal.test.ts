import { describe, expect, it } from 'vitest';
import { vaultPaymentSource } from '../src/paypal.js';

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
