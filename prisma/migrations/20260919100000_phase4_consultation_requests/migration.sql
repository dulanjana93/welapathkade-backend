-- CreateTable Consultation
CREATE TABLE `Consultation` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `astrologerId` VARCHAR(191) NOT NULL,
    `astrologerServiceId` VARCHAR(191) NOT NULL,
    `serviceId` VARCHAR(191) NOT NULL,
    `requestedPrice` DECIMAL(12, 2) NOT NULL,
    `serviceNameSi` VARCHAR(191) NOT NULL,
    `serviceNameEn` VARCHAR(191) NOT NULL,
    `message` TEXT NULL,
    `status` ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `preferredStartAt` DATETIME(3) NOT NULL,
    `preferredEndAt` DATETIME(3) NULL,
    `submittedAt` DATETIME(3) NOT NULL,
    `viewedAt` DATETIME(3) NULL,
    `respondedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `declineReason` VARCHAR(500) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Consultation_customerId_idx`(`customerId`),
    INDEX `Consultation_astrologerId_idx`(`astrologerId`),
    INDEX `Consultation_status_idx`(`status`),
    INDEX `Consultation_expiresAt_idx`(`expiresAt`),
    INDEX `Consultation_submittedAt_idx`(`submittedAt`),
    INDEX `Consultation_astrologerId_status_submittedAt_idx`(`astrologerId`, `status`, `submittedAt`),
    INDEX `Consultation_customerId_status_submittedAt_idx`(`customerId`, `status`, `submittedAt`),
    INDEX `Consultation_status_expiresAt_idx`(`status`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable File
CREATE TABLE `File` (
    `id` VARCHAR(191) NOT NULL,
    `provider` ENUM('CLOUDFLARE_R2') NOT NULL DEFAULT 'CLOUDFLARE_R2',
    `bucket` VARCHAR(191) NOT NULL,
    `objectKey` VARCHAR(191) NOT NULL,
    `originalFilename` VARCHAR(191) NOT NULL,
    `mimeType` VARCHAR(191) NOT NULL,
    `sizeBytes` INT NOT NULL,
    `checksum` VARCHAR(191) NULL,
    `uploadedByUserId` VARCHAR(191) NOT NULL,
    `status` ENUM('UPLOADING', 'AVAILABLE', 'DELETED') NOT NULL DEFAULT 'UPLOADING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `File_objectKey_key`(`objectKey`),
    INDEX `File_uploadedByUserId_idx`(`uploadedByUserId`),
    INDEX `File_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable ConsultationFile
CREATE TABLE `ConsultationFile` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `fileId` VARCHAR(191) NOT NULL,
    `type` ENUM('KUNDALI', 'VOICE_NOTE') NOT NULL,
    `sortOrder` INT NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ConsultationFile_consultationId_idx`(`consultationId`),
    INDEX `ConsultationFile_fileId_idx`(`fileId`),
    UNIQUE INDEX `ConsultationFile_consultationId_fileId_key`(`consultationId`, `fileId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Consultation` ADD CONSTRAINT `Consultation_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `Consultation` ADD CONSTRAINT `Consultation_astrologerId_fkey` FOREIGN KEY (`astrologerId`) REFERENCES `AstrologerProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `Consultation` ADD CONSTRAINT `Consultation_astrologerServiceId_fkey` FOREIGN KEY (`astrologerServiceId`) REFERENCES `AstrologerService`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `Consultation` ADD CONSTRAINT `Consultation_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `Service`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `File` ADD CONSTRAINT `File_uploadedByUserId_fkey` FOREIGN KEY (`uploadedByUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ConsultationFile` ADD CONSTRAINT `ConsultationFile_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `Consultation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ConsultationFile` ADD CONSTRAINT `ConsultationFile_fileId_fkey` FOREIGN KEY (`fileId`) REFERENCES `File`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
