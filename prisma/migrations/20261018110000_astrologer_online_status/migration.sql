-- Manual Online/Offline presence for accepting new consultation requests.
-- Existing rows default to Offline (false).

ALTER TABLE `AstrologerProfile`
  ADD COLUMN `isOnline` BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX `AstrologerProfile_isOnline_idx` ON `AstrologerProfile`(`isOnline`);
