-- Saved-card charge attempts. openChargeSlot is the payment id while the
-- attempt is in flight, pending, or uncertain, so a second charge cannot start.
-- requiresReview stays true until Retrieval or a verified notification
-- identifies the original attempt. It is not a second charge.

ALTER TABLE `PaymentAttempt`
    ADD COLUMN `requiresReview` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `openChargeSlot` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `PaymentAttempt_openChargeSlot_key` ON `PaymentAttempt`(`openChargeSlot`);

CREATE INDEX `PaymentAttempt_requiresReview_idx` ON `PaymentAttempt`(`requiresReview`);
