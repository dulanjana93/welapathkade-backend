-- Phase 2: optional astrologer summary + consultation-scoped follow-up messages.

ALTER TABLE `Consultation`
  ADD COLUMN `astrologerSummary` TEXT NULL,
  ADD COLUMN `astrologerSummaryUpdatedAt` DATETIME(3) NULL;

CREATE TABLE `ConsultationFollowUpMessage` (
  `id` VARCHAR(191) NOT NULL,
  `consultationId` VARCHAR(191) NOT NULL,
  `senderUserId` VARCHAR(191) NOT NULL,
  `body` VARCHAR(2000) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `ConsultationFollowUpMessage_consultationId_createdAt_idx`
  ON `ConsultationFollowUpMessage`(`consultationId`, `createdAt`);

CREATE INDEX `ConsultationFollowUpMessage_consultationId_senderUserId_idx`
  ON `ConsultationFollowUpMessage`(`consultationId`, `senderUserId`);

ALTER TABLE `ConsultationFollowUpMessage`
  ADD CONSTRAINT `ConsultationFollowUpMessage_consultationId_fkey`
  FOREIGN KEY (`consultationId`) REFERENCES `Consultation`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ConsultationFollowUpMessage`
  ADD CONSTRAINT `ConsultationFollowUpMessage_senderUserId_fkey`
  FOREIGN KEY (`senderUserId`) REFERENCES `User`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
