-- Phase 1: appointment lifecycle beyond CONFIRMED (additive; existing rows unaffected).

-- AlterTable Appointment
ALTER TABLE `Appointment`
    MODIFY `status` ENUM('PAYMENT_PENDING', 'CONFIRMED', 'PAYMENT_EXPIRED', 'CANCELLED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_ASTROLOGER', 'NO_SHOW_CUSTOMER', 'NO_SHOW_ASTROLOGER', 'NO_SHOW_BOTH') NOT NULL DEFAULT 'PAYMENT_PENDING',
    ADD COLUMN `sessionStartedAt` DATETIME(3) NULL,
    ADD COLUMN `sessionEndedAt` DATETIME(3) NULL,
    ADD COLUMN `actualDurationSeconds` INTEGER NULL,
    ADD COLUMN `sessionStartEventId` VARCHAR(191) NULL,
    ADD COLUMN `sessionEndEventId` VARCHAR(191) NULL,
    ADD COLUMN `cancelledAt` DATETIME(3) NULL,
    ADD COLUMN `cancelReason` VARCHAR(500) NULL,
    ADD COLUMN `noShowRecordedAt` DATETIME(3) NULL,
    ADD COLUMN `refundObligation` ENUM('FULL_REFUND_DUE') NULL,
    ADD COLUMN `refundObligationRecordedAt` DATETIME(3) NULL,
    ADD COLUMN `manualReviewRequired` BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX `Appointment_sessionStartEventId_key` ON `Appointment`(`sessionStartEventId`);
CREATE UNIQUE INDEX `Appointment_sessionEndEventId_key` ON `Appointment`(`sessionEndEventId`);

-- CreateTable AstrologerReliabilityIncident
CREATE TABLE `AstrologerReliabilityIncident` (
    `id` VARCHAR(191) NOT NULL,
    `astrologerId` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `type` ENUM('CANCELLATION', 'NO_SHOW') NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AstrologerReliabilityIncident_appointmentId_type_key`(`appointmentId`, `type`),
    INDEX `AstrologerReliabilityIncident_astrologerId_createdAt_idx`(`astrologerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AstrologerReliabilityIncident` ADD CONSTRAINT `AstrologerReliabilityIncident_astrologerId_fkey` FOREIGN KEY (`astrologerId`) REFERENCES `AstrologerProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AstrologerReliabilityIncident` ADD CONSTRAINT `AstrologerReliabilityIncident_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `Appointment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
