/** Post-session text follow-up window (authoritative completion → expiry). */
export const FOLLOW_UP_WINDOW_HOURS = 48;

/** Maximum successfully persisted customer messages per consultation. */
export const FOLLOW_UP_CUSTOMER_MESSAGE_LIMIT = 5;

/** Plain-text body length (matches DTO / DB VARCHAR). */
export const FOLLOW_UP_MESSAGE_MAX_LENGTH = 2000;

/** Optional astrologer summary length (matches request-message convention). */
export const ASTROLOGER_SUMMARY_MAX_LENGTH = 4000;
