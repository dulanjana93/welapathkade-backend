-- AlterEnum OtpPurpose (MySQL)
ALTER TABLE `OtpVerification` MODIFY `purpose` ENUM('REGISTRATION', 'PUBLIC_REGISTRATION', 'ASTROLOGER_REGISTRATION', 'LOGIN', 'PHONE_CHANGE') NOT NULL;

-- CreateTable AstrologerApplication
CREATE TABLE `AstrologerApplication` (
    `id` VARCHAR(191) NOT NULL,
    `astrologerProfileId` VARCHAR(191) NOT NULL,
    `status` ENUM('DRAFT', 'PENDING_REVIEW', 'REJECTED', 'APPROVED') NOT NULL DEFAULT 'DRAFT',
    `rejectionReason` TEXT NULL,
    `submittedAt` DATETIME(3) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewedByAdminId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AstrologerApplication_astrologerProfileId_key`(`astrologerProfileId`),
    INDEX `AstrologerApplication_status_idx`(`status`),
    INDEX `AstrologerApplication_reviewedByAdminId_idx`(`reviewedByAdminId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable AuditLog
CREATE TABLE `AuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `adminUserId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NOT NULL,
    `oldData` JSON NULL,
    `newData` JSON NULL,
    `ip` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_adminUserId_idx`(`adminUserId`),
    INDEX `AuditLog_entityType_entityId_idx`(`entityType`, `entityId`),
    INDEX `AuditLog_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AstrologerApplication` ADD CONSTRAINT `AstrologerApplication_astrologerProfileId_fkey` FOREIGN KEY (`astrologerProfileId`) REFERENCES `AstrologerProfile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AstrologerApplication` ADD CONSTRAINT `AstrologerApplication_reviewedByAdminId_fkey` FOREIGN KEY (`reviewedByAdminId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_adminUserId_fkey` FOREIGN KEY (`adminUserId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
