-- Approved withdrawals can be cancelled without a payout when they cannot be paid safely.
-- Existing rows stay in their current status. CANCELLED is a new terminal value.

ALTER TABLE `WithdrawalRequest`
    MODIFY `status` ENUM('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED') NOT NULL DEFAULT 'PENDING_REVIEW';

ALTER TABLE `WithdrawalEvent`
    MODIFY `action` ENUM('CREATED', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED') NOT NULL;

ALTER TABLE `WithdrawalRequest`
    ADD COLUMN `cancelledAt` DATETIME(3) NULL,
    ADD COLUMN `cancelledByAdminId` VARCHAR(191) NULL,
    ADD COLUMN `cancellationReason` VARCHAR(500) NULL;

ALTER TABLE `WithdrawalRequest`
    ADD CONSTRAINT `WithdrawalRequest_cancelledByAdminId_fkey`
    FOREIGN KEY (`cancelledByAdminId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
