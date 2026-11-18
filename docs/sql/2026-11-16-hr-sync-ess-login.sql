-- HR sync + ESS sign-in schema change (2026-11-16)
-- REVIEW BEFORE DEPLOYING. Take a backup first.
--
-- The app applies this automatically on `npm run migrate` or `npm start`
-- (models/legacyMigration.js -> ensureEssLoginSchema, plus Sequelize sync for the new table).
-- Each statement runs only if still needed, so running it twice is safe.
-- The strings in ensureEssLoginSchema are exactly the ones below.

-- ---------------------------------------------------------------------------
-- 1. EXISTING TABLE `Users`
-- ---------------------------------------------------------------------------

-- HR-synced employees have no local password (they use their ESS password via JVzPay).
-- Existing rows keep their hashes; nothing is cleared.
ALTER TABLE `Users` MODIFY `password` VARCHAR(255) NULL;

-- HR job title, used only for the position -> role mapping.
ALTER TABLE `Users` ADD COLUMN `position` VARCHAR(160) NULL;
-- Last HR employment status seen (Onboarding, Active, On Leave, Resigned, Terminated, ...).
ALTER TABLE `Users` ADD COLUMN `hrStatus` VARCHAR(30) NULL;
-- 1 = a manager set the role by hand; the HR sync leaves it alone.
ALTER TABLE `Users` ADD COLUMN `roleOverridden` TINYINT(1) NOT NULL DEFAULT 0;
-- NULL = never activated (first ESS sign-in activates). Set = activated at least once.
ALTER TABLE `Users` ADD COLUMN `activatedAt` DATETIME NULL;
-- When the HR sync last updated this row.
ALTER TABLE `Users` ADD COLUMN `hrSyncedAt` DATETIME NULL;

-- Runs once, right after `activatedAt` is added: every account that exists today counts
-- as already activated, so an account a manager has deactivated cannot be
-- reactivated by an ESS sign-in.
UPDATE `Users` SET `activatedAt` = `createdAt` WHERE `activatedAt` IS NULL;

-- No salary, birth date, address, contact or Employee Unique Code columns are added.

-- ---------------------------------------------------------------------------
-- 2. NEW TABLE `LoginAttempts` (sign-in audit and rate limiting; never stores passwords)
--    Created by Sequelize sync; this is the statement it generates on MySQL.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `LoginAttempts` (
  `id` INTEGER auto_increment,
  `email` VARCHAR(190) NOT NULL,
  `ipAddress` VARCHAR(64) NOT NULL,
  `mode` VARCHAR(20) NOT NULL,                -- local | live | emergency
  `outcome` ENUM('success', 'failure', 'rate_limited', 'ess_unavailable') NOT NULL,
  `reason` VARCHAR(60) NOT NULL,              -- e.g. wrong_password, ess_invalid_credentials, not_in_synced_list
  `userId` INTEGER,
  `createdAt` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;
ALTER TABLE `LoginAttempts` ADD INDEX `idx_login_attempts_email_created` (`email`, `createdAt`);
ALTER TABLE `LoginAttempts` ADD INDEX `idx_login_attempts_ip_created` (`ipAddress`, `createdAt`);

-- ---------------------------------------------------------------------------
-- Rollback (only before any HR-synced account exists, since those rows have NULL passwords):
--   DROP TABLE `LoginAttempts`;
--   ALTER TABLE `Users` DROP COLUMN `hrSyncedAt`, DROP COLUMN `activatedAt`,
--     DROP COLUMN `roleOverridden`, DROP COLUMN `hrStatus`, DROP COLUMN `position`;
--   ALTER TABLE `Users` MODIFY `password` VARCHAR(255) NOT NULL;
-- ---------------------------------------------------------------------------
