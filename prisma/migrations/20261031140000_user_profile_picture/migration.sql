-- AlterTable
ALTER TABLE `User` ADD COLUMN `profilePictureFileId` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `User_profilePictureFileId_key` ON `User`(`profilePictureFileId`);

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_profilePictureFileId_fkey` FOREIGN KEY (`profilePictureFileId`) REFERENCES `File`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
