-- Per-rule message override: a job-specific alert rule can carry its own
-- subject/body, rendered with the same {{ variable }} engine. NULL = fall back
-- to the workspace template, then the built-in default.
ALTER TABLE `AlertRule`
  ADD COLUMN `subject` VARCHAR(191) NULL,
  ADD COLUMN `body` TEXT NULL;
