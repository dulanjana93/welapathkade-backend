-- AlterTable
ALTER TABLE `Payment` MODIFY `provider` ENUM('MOCK', 'PAYHERE') NOT NULL DEFAULT 'MOCK';

-- AlterTable
ALTER TABLE `PaymentAttempt` MODIFY `provider` ENUM('MOCK', 'PAYHERE') NOT NULL DEFAULT 'MOCK';

-- CreateTable
CREATE TABLE `PayHereNotification` (
    `id` VARCHAR(191) NOT NULL,
    `merchantReference` VARCHAR(191) NOT NULL,
    `payherePaymentId` VARCHAR(64) NOT NULL DEFAULT '',
    `statusCode` INTEGER NOT NULL,
    `amount` DECIMAL(12, 2) NULL,
    `currency` VARCHAR(8) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PayHereNotification_merchantRef_paymentId_statusCode_key`(`merchantReference`, `payherePaymentId`, `statusCode`),
    INDEX `PayHereNotification_merchantReference_idx`(`merchantReference`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
