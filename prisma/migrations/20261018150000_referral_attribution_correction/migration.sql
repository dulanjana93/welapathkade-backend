-- Phase C: append-only audited referral attribution corrections.

CREATE TABLE `ReferralAttributionCorrection` (
    `id` VARCHAR(191) NOT NULL,
    `targetUserId` VARCHAR(191) NOT NULL,
    `previousReferrerUserId` VARCHAR(191) NULL,
    `newReferrerUserId` VARCHAR(191) NULL,
    `adminUserId` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReferralAttributionCorrection_targetUserId_createdAt_idx`(`targetUserId`, `createdAt`),
    INDEX `ReferralAttributionCorrection_adminUserId_idx`(`adminUserId`),
    INDEX `ReferralAttributionCorrection_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ReferralAttributionCorrection`
  ADD CONSTRAINT `ReferralAttributionCorrection_targetUserId_fkey`
  FOREIGN KEY (`targetUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ReferralAttributionCorrection`
  ADD CONSTRAINT `ReferralAttributionCorrection_adminUserId_fkey`
  FOREIGN KEY (`adminUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
