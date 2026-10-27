-- Phase A: immutable financial allocation snapshot (no wallet/ledger credits).

CREATE TABLE `AppointmentFinancialSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `currency` VARCHAR(8) NOT NULL,
    `grossAmount` DECIMAL(12, 2) NOT NULL,
    `basis` VARCHAR(64) NOT NULL DEFAULT 'GROSS_CONSULTATION_AMOUNT',
    `astrologerId` VARCHAR(191) NOT NULL,
    `astrologerPercent` DECIMAL(5, 2) NOT NULL,
    `astrologerAmount` DECIMAL(12, 2) NOT NULL,
    `customerReferrerUserId` VARCHAR(191) NULL,
    `customerReferralPercent` DECIMAL(5, 2) NOT NULL,
    `customerReferralAmount` DECIMAL(12, 2) NOT NULL,
    `astrologerReferrerUserId` VARCHAR(191) NULL,
    `astrologerReferralPercent` DECIMAL(5, 2) NOT NULL,
    `astrologerReferralAmount` DECIMAL(12, 2) NOT NULL,
    `platformPercent` DECIMAL(5, 2) NOT NULL,
    `platformAmount` DECIMAL(12, 2) NOT NULL,
    `status` ENUM('RECORDED') NOT NULL DEFAULT 'RECORDED',
    `completedAt` DATETIME(3) NOT NULL,
    `holdExpiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AppointmentFinancialSnapshot_appointmentId_key`(`appointmentId`),
    UNIQUE INDEX `AppointmentFinancialSnapshot_paymentId_key`(`paymentId`),
    INDEX `AppointmentFinancialSnapshot_consultationId_idx`(`consultationId`),
    INDEX `AppointmentFinancialSnapshot_astrologerId_idx`(`astrologerId`),
    INDEX `AppointmentFinancialSnapshot_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `AppointmentFinancialSnapshot_holdExpiresAt_idx`(`holdExpiresAt`),
    INDEX `AppointmentFinancialSnapshot_completedAt_idx`(`completedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AppointmentFinancialSnapshot`
  ADD CONSTRAINT `AppointmentFinancialSnapshot_appointmentId_fkey`
  FOREIGN KEY (`appointmentId`) REFERENCES `Appointment`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `AppointmentFinancialSnapshot`
  ADD CONSTRAINT `AppointmentFinancialSnapshot_consultationId_fkey`
  FOREIGN KEY (`consultationId`) REFERENCES `Consultation`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `AppointmentFinancialSnapshot`
  ADD CONSTRAINT `AppointmentFinancialSnapshot_paymentId_fkey`
  FOREIGN KEY (`paymentId`) REFERENCES `Payment`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `AppointmentFinancialSnapshot`
  ADD CONSTRAINT `AppointmentFinancialSnapshot_astrologerId_fkey`
  FOREIGN KEY (`astrologerId`) REFERENCES `AstrologerProfile`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
