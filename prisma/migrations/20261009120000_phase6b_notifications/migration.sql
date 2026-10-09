-- CreateTable Notification
CREATE TABLE `Notification` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `type` ENUM('CONSULTATION_REQUESTED', 'CONSULTATION_ACCEPTED', 'CONSULTATION_DECLINED', 'PROPOSAL_CREATED', 'PROPOSAL_ACCEPTED', 'PROPOSAL_REJECTED', 'APPOINTMENT_CONFIRMED') NOT NULL,
    `referenceId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(160) NOT NULL,
    `body` VARCHAR(500) NOT NULL,
    `data` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sentAt` DATETIME(3) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,

    INDEX `Notification_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `Notification_sentAt_createdAt_idx`(`sentAt`, `createdAt`),
    UNIQUE INDEX `Notification_userId_type_referenceId_key`(`userId`, `type`, `referenceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Notification` ADD CONSTRAINT `Notification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
