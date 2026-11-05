-- Snapshot of the card selected for a saved-card charge.
-- Existing attempts stay valid with NULL. Deleting a card cannot delete
-- the payment attempt.

ALTER TABLE `PaymentAttempt`
    ADD COLUMN `savedPaymentMethodId` VARCHAR(191) NULL;

CREATE INDEX `PaymentAttempt_savedPaymentMethodId_idx` ON `PaymentAttempt`(`savedPaymentMethodId`);

ALTER TABLE `PaymentAttempt`
    ADD CONSTRAINT `PaymentAttempt_savedPaymentMethodId_fkey`
    FOREIGN KEY (`savedPaymentMethodId`) REFERENCES `SavedPaymentMethod`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
