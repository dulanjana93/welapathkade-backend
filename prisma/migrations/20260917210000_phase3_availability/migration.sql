-- CreateTable WeeklyAvailability
CREATE TABLE `WeeklyAvailability` (
    `id` VARCHAR(191) NOT NULL,
    `astrologerId` VARCHAR(191) NOT NULL,
    `dayOfWeek` ENUM('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY') NOT NULL,
    `startTime` VARCHAR(5) NOT NULL,
    `endTime` VARCHAR(5) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `WeeklyAvailability_astrologerId_idx`(`astrologerId`),
    INDEX `WeeklyAvailability_astrologerId_dayOfWeek_idx`(`astrologerId`, `dayOfWeek`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable AvailabilityException
CREATE TABLE `AvailabilityException` (
    `id` VARCHAR(191) NOT NULL,
    `astrologerId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `type` ENUM('UNAVAILABLE', 'AVAILABLE_OVERRIDE') NOT NULL,
    `startTime` VARCHAR(5) NULL,
    `endTime` VARCHAR(5) NULL,
    `reason` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AvailabilityException_astrologerId_idx`(`astrologerId`),
    INDEX `AvailabilityException_astrologerId_date_idx`(`astrologerId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable AstrologerBookingGuard
CREATE TABLE `AstrologerBookingGuard` (
    `astrologerId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`astrologerId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WeeklyAvailability` ADD CONSTRAINT `WeeklyAvailability_astrologerId_fkey` FOREIGN KEY (`astrologerId`) REFERENCES `AstrologerProfile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AvailabilityException` ADD CONSTRAINT `AvailabilityException_astrologerId_fkey` FOREIGN KEY (`astrologerId`) REFERENCES `AstrologerProfile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AstrologerBookingGuard` ADD CONSTRAINT `AstrologerBookingGuard_astrologerId_fkey` FOREIGN KEY (`astrologerId`) REFERENCES `AstrologerProfile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill booking guards for existing astrologers
INSERT INTO `AstrologerBookingGuard` (`astrologerId`, `createdAt`, `updatedAt`)
SELECT `id`, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3) FROM `AstrologerProfile`
WHERE `id` NOT IN (SELECT `astrologerId` FROM `AstrologerBookingGuard`);
