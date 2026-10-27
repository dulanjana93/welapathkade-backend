-- Document and image attachment kinds. KUNDALI and VOICE_NOTE stay for existing rows.
ALTER TABLE `ConsultationFile` MODIFY `type` ENUM('KUNDALI', 'VOICE_NOTE', 'DOCUMENT', 'IMAGE') NOT NULL;

-- Local disk is a dev/test driver. Production uses CLOUDFLARE_R2 (S3-compatible).
ALTER TABLE `File` MODIFY `provider` ENUM('CLOUDFLARE_R2', 'LOCAL') NOT NULL DEFAULT 'CLOUDFLARE_R2';

-- Create the unique index before dropping the non-unique one. MySQL uses
-- ConsultationFile_fileId_idx for the foreign key, so it cannot be dropped first.
CREATE UNIQUE INDEX `ConsultationFile_fileId_key` ON `ConsultationFile`(`fileId`);

DROP INDEX `ConsultationFile_fileId_idx` ON `ConsultationFile`;
