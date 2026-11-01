-- CreateTable
CREATE TABLE `SavedPaymentMethod` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `provider` ENUM('MOCK', 'PAYHERE') NOT NULL DEFAULT 'PAYHERE',
    `status` ENUM('PENDING', 'ACTIVE', 'DISABLED', 'REMOVED', 'FAILED') NOT NULL,
    `merchantReference` VARCHAR(191) NOT NULL,
    `payherePaymentId` VARCHAR(64) NULL,
    `tokenCiphertext` TEXT NULL,
    `tokenIv` VARCHAR(32) NULL,
    `tokenTag` VARCHAR(32) NULL,
    `cardBrand` VARCHAR(16) NULL,
    `cardLast4` VARCHAR(4) NULL,
    `consentVersion` VARCHAR(32) NOT NULL,
    `consentedAt` DATETIME(3) NOT NULL,
    `authorizationEnabled` BOOLEAN NOT NULL DEFAULT false,
    `revokedAt` DATETIME(3) NULL,
    `removedAt` DATETIME(3) NULL,
    `openCardSlot` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SavedPaymentMethod_merchantReference_key`(`merchantReference`),
    UNIQUE INDEX `SavedPaymentMethod_openCardSlot_key`(`openCardSlot`),
    INDEX `SavedPaymentMethod_userId_status_idx`(`userId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SavedCardConsentEvent` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `savedPaymentMethodId` VARCHAR(191) NOT NULL,
    `type` ENUM('CONSENT_GRANTED', 'CONSENT_REVOKED', 'CARD_REMOVED') NOT NULL,
    `consentVersion` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SavedCardConsentEvent_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `SavedCardConsentEvent_savedPaymentMethodId_idx`(`savedPaymentMethodId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SavedPaymentMethod` ADD CONSTRAINT `SavedPaymentMethod_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SavedCardConsentEvent` ADD CONSTRAINT `SavedCardConsentEvent_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SavedCardConsentEvent` ADD CONSTRAINT `SavedCardConsentEvent_savedPaymentMethodId_fkey` FOREIGN KEY (`savedPaymentMethodId`) REFERENCES `SavedPaymentMethod`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
