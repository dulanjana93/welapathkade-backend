export const AUTOMATIC_PAYMENT_CONSENT_VERSION = '2026-11-01';

/**
 * Shown before card registration and stored by version on each consent event.
 * The customer must accept this exact version. A later version requires a new acceptance.
 */
export const AUTOMATIC_PAYMENT_CONSENT_TEXT =
  'I agree to save this card with Welapathkade and to authorize future automatic charges for consultations under Welapathkade consultation payment terms. PayHere charges Rs. 1.00 to verify the card and refunds that Rs. 1.00 immediately. That verification is not a consultation payment. I can revoke this authorization at any time. Revoking it disables this saved card in Welapathkade, deletes Welapathkade’s copy of the card token, and stops Welapathkade from charging this card. I will need to register a card again and accept this consent again before a card can be used. Revoking or removing the card in Welapathkade does not by itself cancel the pre-approval inside PayHere’s merchant account.';
