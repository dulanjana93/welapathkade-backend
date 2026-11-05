-- A PENDING registration keeps openCardSlot. Every other status releases it
-- so more than one ACTIVE card can exist. Rows, ciphertext, and consent
-- events are left in place. The unique index is unchanged.
UPDATE `SavedPaymentMethod`
SET `openCardSlot` = NULL
WHERE `status` <> 'PENDING';
