-- Saved-card registration no longer stays PENDING while waiting for PayHere.
-- Additive only: no existing row is changed or deleted here. Existing PENDING
-- rows are resolved separately (see docs/saved-card-registration.md).
ALTER TABLE `SavedPaymentMethod`
    ADD COLUMN `failureReason` ENUM('PAYHERE_DECLINED', 'PAYHERE_CANCELLED', 'CUSTOMER_CANCELLED', 'NOT_CONFIRMED', 'SUPERSEDED', 'ABANDONED', 'LEGACY_PENDING') NULL,
    ADD COLUMN `failedAt` DATETIME(3) NULL,
    ADD COLUMN `lateAuthorizationAt` DATETIME(3) NULL;
