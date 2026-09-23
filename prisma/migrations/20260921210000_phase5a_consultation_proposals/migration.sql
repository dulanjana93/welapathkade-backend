-- CreateTable ConsultationProposal
CREATE TABLE `ConsultationProposal` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `proposedStartAt` DATETIME(3) NOT NULL,
    `proposedEndAt` DATETIME(3) NOT NULL,
    `durationMinutes` INT NOT NULL,
    `status` ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `respondedAt` DATETIME(3) NULL,

    INDEX `ConsultationProposal_consultationId_idx`(`consultationId`),
    INDEX `ConsultationProposal_consultationId_status_idx`(`consultationId`, `status`),
    INDEX `ConsultationProposal_status_idx`(`status`),
    INDEX `ConsultationProposal_proposedStartAt_idx`(`proposedStartAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ConsultationProposal` ADD CONSTRAINT `ConsultationProposal_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `Consultation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
