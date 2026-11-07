/** Business timezone — always Asia/Colombo for V1. */
export const BUSINESS_TIMEZONE = 'Asia/Colombo';

/** Minimum lead time before a public bookable slot may start. */
export const MIN_BOOKING_LEAD_MINUTES = 60;

/**
 * Minimum lead time before an astrologer-proposed consultation may start.
 * Enforced by assertProposedSlotEligible (create / accept / Confirm & Pay).
 */
export const MIN_PROPOSAL_LEAD_MINUTES = 5;

/** Maximum days ahead customers may book. */
export const MAX_BOOKING_HORIZON_DAYS = 30;

/**
 * Scheduling buffer between consultations.
 *
 * This is NOT subtracted from displayed availability windows.
 * It is applied by the conflict/scheduling layer around occupied appointments.
 */
export const APPOINTMENT_BUFFER_MINUTES = 10;

/** Default slot grain for slot enumeration (business rule). */
export const SCHEDULING_INTERVAL_MINUTES = 30;

/** Minimum consultation / proposal duration (minutes). */
export const MIN_APPOINTMENT_DURATION_MINUTES = 15;

/** Maximum consultation / proposal duration (minutes). */
export const MAX_APPOINTMENT_DURATION_MINUTES = 240;

/**
 * Maximum preferred customer time-range length (minutes).
 * Preference windows are not appointment durations.
 */
export const MAX_PREFERRED_WINDOW_MINUTES = 12 * 60;

/** Confirm & Pay hold duration before the slot is released. */
export const PAYMENT_RESERVATION_MINUTES = 30;

/** ISO-4217 currency for V1 checkout. */
export const PAYMENT_CURRENCY = 'LKR';
