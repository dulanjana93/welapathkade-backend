import { ConsultationStatus } from '@prisma/client';
import { expirePendingConsultations } from './consultation-expiry';

describe('expirePendingConsultations (the single request-expiry rule)', () => {
  const now = new Date('2026-10-12T04:00:00.000Z');
  const db = { consultation: { updateMany: jest.fn() } };

  beforeEach(() => {
    jest.resetAllMocks();
    db.consultation.updateMany.mockResolvedValue({ count: 3 });
  });

  it('expires only PENDING requests with expiresAt <= now (inclusive) and returns the count', async () => {
    const count = await expirePendingConsultations(db as never, now);
    expect(count).toBe(3);
    expect(db.consultation.updateMany).toHaveBeenCalledWith({
      where: {
        status: ConsultationStatus.PENDING,
        expiresAt: { lte: now },
      },
      data: { status: ConsultationStatus.EXPIRED },
    });
  });

  it('narrows to a scope without ever widening past PENDING', async () => {
    await expirePendingConsultations(db as never, now, {
      customerId: 'cust-1',
    });
    expect(db.consultation.updateMany).toHaveBeenCalledWith({
      where: {
        customerId: 'cust-1',
        status: ConsultationStatus.PENDING,
        expiresAt: { lte: now },
      },
      data: { status: ConsultationStatus.EXPIRED },
    });
  });

  it('a scope cannot override the status or deadline guards', async () => {
    await expirePendingConsultations(db as never, now, {
      status: ConsultationStatus.ACCEPTED,
      expiresAt: { gt: now },
    });
    const call = (
      db.consultation.updateMany.mock.calls as unknown[][]
    )[0][0] as {
      where: { status: ConsultationStatus; expiresAt: { lte: Date } };
    };
    expect(call.where.status).toBe(ConsultationStatus.PENDING);
    expect(call.where.expiresAt).toEqual({ lte: now });
  });

  it('is idempotent: a second run simply changes nothing', async () => {
    db.consultation.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    expect(await expirePendingConsultations(db as never, now)).toBe(1);
    expect(await expirePendingConsultations(db as never, now)).toBe(0);
  });
});
