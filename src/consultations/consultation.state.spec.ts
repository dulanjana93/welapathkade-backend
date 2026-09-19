import {
  assertConsultationTransition,
  canAstrologerRespond,
  canCustomerCancel,
} from './consultation.state';
import { ConsultationStatus } from '@prisma/client';
import { CONSULTATION_RESPONSE_TIMEOUT_HOURS } from './consultation.constants';

describe('consultation.state', () => {
  it('allows PENDING → ACCEPTED / DECLINED / EXPIRED / CANCELLED', () => {
    expect(assertConsultationTransition(ConsultationStatus.PENDING, 'ACCEPT')).toBe(
      ConsultationStatus.ACCEPTED,
    );
    expect(assertConsultationTransition(ConsultationStatus.PENDING, 'DECLINE')).toBe(
      ConsultationStatus.DECLINED,
    );
    expect(assertConsultationTransition(ConsultationStatus.PENDING, 'TIMEOUT')).toBe(
      ConsultationStatus.EXPIRED,
    );
    expect(
      assertConsultationTransition(ConsultationStatus.PENDING, 'CUSTOMER_CANCEL'),
    ).toBe(ConsultationStatus.CANCELLED);
  });

  it('rejects transitions from terminal / accepted states', () => {
    for (const status of [
      ConsultationStatus.ACCEPTED,
      ConsultationStatus.DECLINED,
      ConsultationStatus.EXPIRED,
      ConsultationStatus.CANCELLED,
    ]) {
      expect(() =>
        assertConsultationTransition(status, 'ACCEPT'),
      ).toThrow(/Invalid consultation transition/);
      expect(() =>
        assertConsultationTransition(status, 'DECLINE'),
      ).toThrow(/Invalid consultation transition/);
      expect(() =>
        assertConsultationTransition(status, 'CUSTOMER_CANCEL'),
      ).toThrow(/Invalid consultation transition/);
    }
  });

  it('gates respond/cancel to PENDING only', () => {
    expect(canAstrologerRespond(ConsultationStatus.PENDING)).toBe(true);
    expect(canAstrologerRespond(ConsultationStatus.ACCEPTED)).toBe(false);
    expect(canCustomerCancel(ConsultationStatus.PENDING)).toBe(true);
    expect(canCustomerCancel(ConsultationStatus.ACCEPTED)).toBe(false);
  });

  it('uses 12-hour SLA constant', () => {
    expect(CONSULTATION_RESPONSE_TIMEOUT_HOURS).toBe(12);
  });
});
