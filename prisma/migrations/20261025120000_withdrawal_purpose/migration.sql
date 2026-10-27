-- Distinguish astrologer earnings withdrawals from customer referral payouts.
-- Existing rows default to ASTROLOGER_EARNINGS and keep their current status.

ALTER TABLE `WithdrawalRequest`
    ADD COLUMN `purpose` ENUM('ASTROLOGER_EARNINGS', 'CUSTOMER_REFERRAL') NOT NULL DEFAULT 'ASTROLOGER_EARNINGS';

CREATE INDEX `WithdrawalRequest_userId_purpose_status_idx` ON `WithdrawalRequest`(`userId`, `purpose`, `status`);
