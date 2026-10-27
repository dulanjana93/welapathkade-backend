-- Phase B: append-only ledger, user wallets, platform residual account.
-- Extends FinancialSnapshotStatus with POSTED / REVERSED.

ALTER TABLE `AppointmentFinancialSnapshot`
  MODIFY `status` ENUM('RECORDED', 'POSTED', 'REVERSED') NOT NULL DEFAULT 'RECORDED';

ALTER TABLE `AppointmentFinancialSnapshot`
  ADD COLUMN `postedAt` DATETIME(3) NULL,
  ADD COLUMN `reversedAt` DATETIME(3) NULL;

CREATE INDEX `AppointmentFinancialSnapshot_status_holdExpiresAt_idx`
  ON `AppointmentFinancialSnapshot`(`status`, `holdExpiresAt`);

CREATE TABLE `LedgerEntry` (
    `id` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `category` ENUM('ASTROLOGER_EARNING', 'CUSTOMER_REFERRAL', 'ASTROLOGER_REFERRAL', 'PLATFORM_RESIDUAL') NOT NULL,
    `kind` ENUM('CREDIT', 'DEBIT') NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `currency` VARCHAR(8) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `snapshotId` VARCHAR(191) NOT NULL,
    `reversesEntryId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `LedgerEntry_idempotencyKey_key`(`idempotencyKey`),
    UNIQUE INDEX `LedgerEntry_reversesEntryId_key`(`reversesEntryId`),
    UNIQUE INDEX `LedgerEntry_snapshotId_category_kind_key`(`snapshotId`, `category`, `kind`),
    INDEX `LedgerEntry_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `LedgerEntry_appointmentId_idx`(`appointmentId`),
    INDEX `LedgerEntry_paymentId_idx`(`paymentId`),
    INDEX `LedgerEntry_category_kind_idx`(`category`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `LedgerEntry`
  ADD CONSTRAINT `LedgerEntry_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `LedgerEntry`
  ADD CONSTRAINT `LedgerEntry_appointmentId_fkey`
  FOREIGN KEY (`appointmentId`) REFERENCES `Appointment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `LedgerEntry`
  ADD CONSTRAINT `LedgerEntry_consultationId_fkey`
  FOREIGN KEY (`consultationId`) REFERENCES `Consultation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `LedgerEntry`
  ADD CONSTRAINT `LedgerEntry_paymentId_fkey`
  FOREIGN KEY (`paymentId`) REFERENCES `Payment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `LedgerEntry`
  ADD CONSTRAINT `LedgerEntry_snapshotId_fkey`
  FOREIGN KEY (`snapshotId`) REFERENCES `AppointmentFinancialSnapshot`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `LedgerEntry`
  ADD CONSTRAINT `LedgerEntry_reversesEntryId_fkey`
  FOREIGN KEY (`reversesEntryId`) REFERENCES `LedgerEntry`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE `WalletAccount` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `currency` VARCHAR(8) NOT NULL DEFAULT 'LKR',
    `availableBalance` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WalletAccount_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WalletAccount`
  ADD CONSTRAINT `WalletAccount_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE `PlatformAccount` (
    `id` VARCHAR(191) NOT NULL,
    `currency` VARCHAR(8) NOT NULL DEFAULT 'LKR',
    `availableBalance` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Singleton platform residual account (not a user wallet).
INSERT INTO `PlatformAccount` (`id`, `currency`, `availableBalance`, `createdAt`, `updatedAt`)
VALUES ('PLATFORM', 'LKR', 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
