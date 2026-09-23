/** Business timezone — always Asia/Colombo for V1. */
export const BUSINESS_TIMEZONE = 'Asia/Colombo';

/** Minimum lead time before a bookable slot may start. */
export const MIN_BOOKING_LEAD_MINUTES = 60;

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
