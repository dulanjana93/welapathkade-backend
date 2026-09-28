/**
 * Confirm & Pay accepts no client money or schedule fields.
 * Amount, start, and end are taken only from Consultation + accepted proposal.
 * Extra properties are rejected by the global ValidationPipe
 * (`forbidNonWhitelisted`).
 */
export class ConfirmCheckoutDto {}
