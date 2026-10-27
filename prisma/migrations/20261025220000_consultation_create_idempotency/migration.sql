-- Additive: optional client submission key for POST /consultations.
-- Existing rows stay NULL. MySQL allows multiple NULLs in this unique index.
ALTER TABLE `Consultation`
    ADD COLUMN `clientIdempotencyKey` VARCHAR(80) NULL,
    ADD COLUMN `requestFingerprint` VARCHAR(64) NULL;

CREATE UNIQUE INDEX `Consultation_customerId_clientIdempotencyKey_key`
    ON `Consultation`(`customerId`, `clientIdempotencyKey`);
