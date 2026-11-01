-- AlterTable
ALTER TABLE `User`
    ADD COLUMN `billingFirstName` VARCHAR(80) NULL,
    ADD COLUMN `billingLastName` VARCHAR(80) NULL,
    ADD COLUMN `billingEmail` VARCHAR(254) NULL,
    ADD COLUMN `billingAddress` VARCHAR(255) NULL,
    ADD COLUMN `billingCity` VARCHAR(80) NULL,
    ADD COLUMN `billingCountry` VARCHAR(80) NULL;
