-- Per-system integration tokens (2026-11-17)
-- No existing table is changed. This adds one new table, created automatically by
-- Sequelize sync on `npm start` / `npm run migrate`, or by the first `npm run token -- ...`.
-- This is the statement Sequelize generates on MySQL:

CREATE TABLE IF NOT EXISTS `IntegrationTokens` (
  `id` INTEGER auto_increment,
  `name` VARCHAR(120) NOT NULL,                  -- e.g. "CRM production"
  `system` ENUM('crm', 'accounting') NOT NULL,   -- which routes the token may call
  `tokenHash` CHAR(64) NOT NULL,                 -- SHA-256 of the token; the token itself is never stored
  `tokenPrefix` VARCHAR(24) NOT NULL,            -- first characters, safe to display (e.g. jvi_crm_AbC1)
  `lastUsedAt` DATETIME,
  `revokedAt` DATETIME,                          -- set by `npm run token -- revoke <id>`
  `createdAt` DATETIME NOT NULL,
  `updatedAt` DATETIME NOT NULL,
  UNIQUE `uq_integration_tokens_hash` (`tokenHash`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

-- Rollback: DROP TABLE `IntegrationTokens`;
