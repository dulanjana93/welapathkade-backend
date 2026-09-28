-- CreateTable Appointment
CREATE TABLE `Appointment` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `proposalId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `astrologerId` VARCHAR(191) NOT NULL,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `durationMinutes` INT NOT NULL,
    `status` ENUM('PAYMENT_PENDING', 'CONFIRMED', 'PAYMENT_EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'PAYMENT_PENDING',
    `amount` DECIMAL(12, 2) NOT NULL,
    `currency` VARCHAR(8) NOT NULL DEFAULT 'LKR',
    `reservationExpiresAt` DATETIME(3) NOT NULL,
    `confirmedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Appointment_proposalId_key`(`proposalId`),
    INDEX `Appointment_astrologerId_status_startAt_idx`(`astrologerId`, `status`, `startAt`),
    INDEX `Appointment_customerId_status_idx`(`customerId`, `status`),
    INDEX `Appointment_consultationId_idx`(`consultationId`),
    INDEX `Appointment_status_reservationExpiresAt_idx`(`status`, `reservationExpiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable Payment
CREATE TABLE `Payment` (
    `id` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `currency` VARCHAR(8) NOT NULL DEFAULT 'LKR',
    `status` ENUM('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `provider` ENUM('MOCK') NOT NULL DEFAULT 'MOCK',
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Payment_appointmentId_key`(`appointmentId`),
    INDEX `Payment_consultationId_idx`(`consultationId`),
    INDEX `Payment_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable PaymentAttempt
CREATE TABLE `PaymentAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `provider` ENUM('MOCK') NOT NULL DEFAULT 'MOCK',
    `merchantReference` VARCHAR(191) NOT NULL,
    `providerPaymentId` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `checkoutPayload` JSON NULL,
    `rawNotifyPayload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PaymentAttempt_merchantReference_key`(`merchantReference`),
    UNIQUE INDEX `PaymentAttempt_providerPaymentId_key`(`providerPaymentId`),
    INDEX `PaymentAttempt_paymentId_idx`(`paymentId`),
    INDEX `PaymentAttempt_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Appointment` ADD CONSTRAINT `Appointment_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `Consultation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Appointment` ADD CONSTRAINT `Appointment_proposalId_fkey` FOREIGN KEY (`proposalId`) REFERENCES `ConsultationProposal`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Appointment` ADD CONSTRAINT `Appointment_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Appointment` ADD CONSTRAINT `Appointment_astrologerId_fkey` FOREIGN KEY (`astrologerId`) REFERENCES `AstrologerProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `Payment` ADD CONSTRAINT `Payment_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `Appointment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `Consultation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `PaymentAttempt` ADD CONSTRAINT `PaymentAttempt_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `Payment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
