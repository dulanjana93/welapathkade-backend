-- CreateTable
CREATE TABLE `AstrologerProfile` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `bio` TEXT NULL,
    `experienceYears` INTEGER NOT NULL DEFAULT 0,
    `photo` VARCHAR(191) NULL,
    `city` VARCHAR(191) NULL,
    `district` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'INACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AstrologerProfile_userId_key`(`userId`),
    INDEX `AstrologerProfile_status_idx`(`status`),
    INDEX `AstrologerProfile_city_idx`(`city`),
    INDEX `AstrologerProfile_district_idx`(`district`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Service` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `nameSi` VARCHAR(191) NOT NULL,
    `nameEn` VARCHAR(191) NOT NULL,
    `descriptionSi` TEXT NULL,
    `descriptionEn` TEXT NULL,
    `minPrice` DECIMAL(12, 2) NOT NULL,
    `maxPrice` DECIMAL(12, 2) NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Service_code_key`(`code`),
    INDEX `Service_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AstrologerService` (
    `id` VARCHAR(191) NOT NULL,
    `astrologerId` VARCHAR(191) NOT NULL,
    `serviceId` VARCHAR(191) NOT NULL,
    `price` DECIMAL(12, 2) NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AstrologerService_astrologerId_idx`(`astrologerId`),
    INDEX `AstrologerService_serviceId_idx`(`serviceId`),
    INDEX `AstrologerService_status_idx`(`status`),
    INDEX `AstrologerService_price_idx`(`price`),
    UNIQUE INDEX `AstrologerService_astrologerId_serviceId_key`(`astrologerId`, `serviceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AstrologerProfile` ADD CONSTRAINT `AstrologerProfile_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AstrologerService` ADD CONSTRAINT `AstrologerService_astrologerId_fkey` FOREIGN KEY (`astrologerId`) REFERENCES `AstrologerProfile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AstrologerService` ADD CONSTRAINT `AstrologerService_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `Service`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
