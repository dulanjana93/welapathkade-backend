-- Phase B3-a: provider-neutral session attendance evidence (facts only).
-- Does not alter appointment lifecycle status or refund/reliability fields.

-- CreateTable
CREATE TABLE `SessionAttendanceEvidence` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(64) NOT NULL,
    `providerEventId` VARCHAR(191) NOT NULL,
    `providerRoomId` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `participantRole` ENUM('CUSTOMER', 'ASTROLOGER') NOT NULL,
    `eventKind` ENUM('PARTICIPANT_JOINED', 'PARTICIPANT_LEFT') NOT NULL,
    `providerOccurredAt` DATETIME(3) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL,
    `sourceMeta` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SessionAttendanceEvidence_provider_providerEventId_key`(`provider`, `providerEventId`),
    INDEX `SessionAttendanceEvidence_appointmentId_providerOccurredAt_idx`(`appointmentId`, `providerOccurredAt`),
    INDEX `SessionAttendanceEvidence_appointmentId_receivedAt_idx`(`appointmentId`, `receivedAt`),
    INDEX `SessionAttendanceEvidence_provider_providerRoomId_idx`(`provider`, `providerRoomId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SessionAttendanceEvidence` ADD CONSTRAINT `SessionAttendanceEvidence_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `Appointment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
