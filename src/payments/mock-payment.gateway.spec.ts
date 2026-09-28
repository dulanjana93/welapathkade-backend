import { MockPaymentGateway } from './mock-payment.gateway';

describe('MockPaymentGateway', () => {
  const gateway = new MockPaymentGateway();

  it('createCheckout returns mock payload with merchant reference', async () => {
    const result = await gateway.createCheckout({
      merchantReference: 'wp_apt_abc',
      amount: '1500.00',
      currency: 'LKR',
      appointmentId: 'apt-1',
      consultationId: 'c-1',
      customer: { id: 'u1', name: 'Kamal', phone: '+94770000001' },
    });
    expect(result.checkout).toMatchObject({
      mock: true,
      provider: 'MOCK',
      merchantReference: 'wp_apt_abc',
      notifyPath: '/payments/callbacks/mock',
    });
  });

  it('verifyNotify without amount still succeeds; verifyByReference remembers it', async () => {
    const notify = await gateway.verifyNotify(
      {},
      JSON.stringify({
        merchantReference: 'wp_ref_1',
        success: true,
      }),
    );
    expect(notify.success).toBe(true);
    expect(notify.merchantReference).toBe('wp_ref_1');
    expect(notify.amount).toBe('');

    const verified = await gateway.verifyByReference('wp_ref_1');
    expect(verified.success).toBe(true);
    expect(verified.pending).toBe(false);
  });

  it('verifyByReference is pending until a successful notify', async () => {
    const pending = await gateway.verifyByReference('never-paid');
    expect(pending.success).toBe(false);
    expect(pending.pending).toBe(true);
  });
});
