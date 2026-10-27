-- Astrologer bank accounts and manual withdrawal lifecycle.
-- Wallet availableBalance is unchanged until a confirmed payout debit is posted.
-- WithdrawalDebit is separate from LedgerEntry so payouts are not earning reversals.

CREATE TABLE `AstrologerBankAccount` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `bankName` VARCHAR(120) NOT NULL,
    `accountHolderName` VARCHAR(120) NOT NULL,
    `branchName` VARCHAR(120) NOT NULL,
    `bankCode` VARCHAR(32) NULL,
    `branchCode` VARCHAR(32) NULL,
    `accountNumberLast4` VARCHAR(4) NOT NULL,
    `accountNumberCiphertext` VARCHAR(512) NOT NULL,
    `accountNumberIv` VARCHAR(32) NOT NULL,
    `accountNumberTag` VARCHAR(32) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AstrologerBankAccount_userId_isActive_idx`(`userId`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AstrologerBankAccount`
  ADD CONSTRAINT `AstrologerBankAccount_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE `WithdrawalRequest` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `bankAccountId` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `currency` VARCHAR(8) NOT NULL DEFAULT 'LKR',
    `status` ENUM('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PAID') NOT NULL DEFAULT 'PENDING_REVIEW',
    `clientIdempotencyKey` VARCHAR(80) NULL,
    `destinationBankName` VARCHAR(120) NOT NULL,
    `destinationAccountHolderName` VARCHAR(120) NOT NULL,
    `destinationBranchName` VARCHAR(120) NOT NULL,
    `destinationBankCode` VARCHAR(32) NULL,
    `destinationBranchCode` VARCHAR(32) NULL,
    `destinationAccountLast4` VARCHAR(4) NOT NULL,
    `destinationAccountCiphertext` VARCHAR(512) NOT NULL,
    `destinationAccountIv` VARCHAR(32) NOT NULL,
    `destinationAccountTag` VARCHAR(32) NOT NULL,
    `approvedAt` DATETIME(3) NULL,
    `approvedByAdminId` VARCHAR(191) NULL,
    `rejectedAt` DATETIME(3) NULL,
    `rejectedByAdminId` VARCHAR(191) NULL,
    `rejectionReason` VARCHAR(500) NULL,
    `paidAt` DATETIME(3) NULL,
    `paidByAdminId` VARCHAR(191) NULL,
    `transferRecordedAt` DATETIME(3) NULL,
    `actualTransferredAt` DATETIME(3) NULL,
    `transferReference` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WithdrawalRequest_transferReference_key`(`transferReference`),
    UNIQUE INDEX `WithdrawalRequest_userId_clientIdempotencyKey_key`(`userId`, `clientIdempotencyKey`),
    INDEX `WithdrawalRequest_userId_status_createdAt_idx`(`userId`, `status`, `createdAt`),
    INDEX `WithdrawalRequest_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `WithdrawalRequest_bankAccountId_idx`(`bankAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WithdrawalRequest`
  ADD CONSTRAINT `WithdrawalRequest_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `WithdrawalRequest`
  ADD CONSTRAINT `WithdrawalRequest_bankAccountId_fkey`
  FOREIGN KEY (`bankAccountId`) REFERENCES `AstrologerBankAccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `WithdrawalRequest`
  ADD CONSTRAINT `WithdrawalRequest_approvedByAdminId_fkey`
  FOREIGN KEY (`approvedByAdminId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `WithdrawalRequest`
  ADD CONSTRAINT `WithdrawalRequest_rejectedByAdminId_fkey`
  FOREIGN KEY (`rejectedByAdminId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `WithdrawalRequest`
  ADD CONSTRAINT `WithdrawalRequest_paidByAdminId_fkey`
  FOREIGN KEY (`paidByAdminId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE `WithdrawalDebit` (
    `id` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `withdrawalRequestId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `currency` VARCHAR(8) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `WithdrawalDebit_idempotencyKey_key`(`idempotencyKey`),
    UNIQUE INDEX `WithdrawalDebit_withdrawalRequestId_key`(`withdrawalRequestId`),
    INDEX `WithdrawalDebit_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WithdrawalDebit`
  ADD CONSTRAINT `WithdrawalDebit_withdrawalRequestId_fkey`
  FOREIGN KEY (`withdrawalRequestId`) REFERENCES `WithdrawalRequest`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `WithdrawalDebit`
  ADD CONSTRAINT `WithdrawalDebit_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE `WithdrawalEvent` (
    `id` VARCHAR(191) NOT NULL,
    `withdrawalId` VARCHAR(191) NOT NULL,
    `actorUserId` VARCHAR(191) NOT NULL,
    `action` ENUM('CREATED', 'APPROVED', 'REJECTED', 'PAID') NOT NULL,
    `reason` VARCHAR(500) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WithdrawalEvent_withdrawalId_createdAt_idx`(`withdrawalId`, `createdAt`),
    INDEX `WithdrawalEvent_actorUserId_idx`(`actorUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WithdrawalEvent`
  ADD CONSTRAINT `WithdrawalEvent_withdrawalId_fkey`
  FOREIGN KEY (`withdrawalId`) REFERENCES `WithdrawalRequest`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `WithdrawalEvent`
  ADD CONSTRAINT `WithdrawalEvent_actorUserId_fkey`
  FOREIGN KEY (`actorUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
