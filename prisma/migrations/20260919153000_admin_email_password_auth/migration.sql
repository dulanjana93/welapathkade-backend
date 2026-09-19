-- AlterTable
ALTER TABLE `User` ADD COLUMN `email` VARCHAR(191) NULL,
    ADD COLUMN `passwordHash` VARCHAR(255) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `User_email_key` ON `User`(`email`);
