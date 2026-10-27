-- Phase 3: consultation-linked star ratings and optional review text.

CREATE TABLE `ConsultationReview` (
  `id` VARCHAR(191) NOT NULL,
  `consultationId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `astrologerId` VARCHAR(191) NOT NULL,
  `rating` INTEGER NOT NULL,
  `body` VARCHAR(1000) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `ConsultationReview_consultationId_key`(`consultationId`),
  INDEX `ConsultationReview_astrologerId_createdAt_idx`(`astrologerId`, `createdAt`),
  INDEX `ConsultationReview_customerId_idx`(`customerId`),
  INDEX `ConsultationReview_astrologerId_rating_idx`(`astrologerId`, `rating`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ConsultationReview`
  ADD CONSTRAINT `ConsultationReview_consultationId_fkey`
  FOREIGN KEY (`consultationId`) REFERENCES `Consultation`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ConsultationReview`
  ADD CONSTRAINT `ConsultationReview_customerId_fkey`
  FOREIGN KEY (`customerId`) REFERENCES `User`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ConsultationReview`
  ADD CONSTRAINT `ConsultationReview_astrologerId_fkey`
  FOREIGN KEY (`astrologerId`) REFERENCES `AstrologerProfile`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
