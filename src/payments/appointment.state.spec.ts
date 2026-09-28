import { AppointmentStatus } from '@prisma/client';
import {
  assertAppointmentTransition,
  isAppointmentHoldActive,
} from './appointment.state';

describe('appointment.state', () => {
  it('allows PAYMENT_PENDING → CONFIRMED', () => {
    expect(
      assertAppointmentTransition(
        AppointmentStatus.PAYMENT_PENDING,
        'PAYMENT_SUCCESS',
      ),
    ).toBe(AppointmentStatus.CONFIRMED);
  });

  it('allows PAYMENT_PENDING → PAYMENT_EXPIRED', () => {
    expect(
      assertAppointmentTransition(
        AppointmentStatus.PAYMENT_PENDING,
        'PAYMENT_TIMEOUT',
      ),
    ).toBe(AppointmentStatus.PAYMENT_EXPIRED);
  });

  it('rejects confirm from CONFIRMED', () => {
    expect(() =>
      assertAppointmentTransition(
        AppointmentStatus.CONFIRMED,
        'PAYMENT_SUCCESS',
      ),
    ).toThrow(/Invalid appointment transition/);
  });

  it('treats unexpired PAYMENT_PENDING as an active hold', () => {
    const future = new Date(Date.now() + 60_000);
    expect(
      isAppointmentHoldActive(AppointmentStatus.PAYMENT_PENDING, future),
    ).toBe(true);
    expect(
      isAppointmentHoldActive(
        AppointmentStatus.PAYMENT_PENDING,
        new Date(Date.now() - 1000),
      ),
    ).toBe(false);
    expect(
      isAppointmentHoldActive(AppointmentStatus.CONFIRMED, future),
    ).toBe(false);
  });
});
