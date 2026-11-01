-- CreateTable
CREATE TABLE `PayHereRefund` (
    `id` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `payherePaymentId` VARCHAR(64) NOT NULL,
    `payhereRefundNumber` VARCHAR(64) NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `currency` VARCHAR(8) NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REQUIRES_REVIEW') NOT NULL,
    `reason` ENUM('RESERVATION_EXPIRED', 'CANCELLATION', 'NO_SHOW', 'ADMIN_RETRY') NOT NULL,
    `openRefundSlot` VARCHAR(191) NULL,
    `retrySafe` BOOLEAN NOT NULL DEFAULT false,
    `failureMessage` VARCHAR(500) NULL,
    `providerStatus` INTEGER NULL,
    `sanitizedResponse` JSON NULL,
    `initiatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastReconciledAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PayHereRefund_payhereRefundNumber_key`(`payhereRefundNumber`),
    UNIQUE INDEX `PayHereRefund_openRefundSlot_key`(`openRefundSlot`),
    INDEX `PayHereRefund_paymentId_createdAt_idx`(`paymentId`, `createdAt`),
    INDEX `PayHereRefund_appointmentId_idx`(`appointmentId`),
    INDEX `PayHereRefund_status_updatedAt_idx`(`status`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PayHereRefund` ADD CONSTRAINT `PayHereRefund_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `Payment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PayHereRefund` ADD CONSTRAINT `PayHereRefund_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `Appointment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
