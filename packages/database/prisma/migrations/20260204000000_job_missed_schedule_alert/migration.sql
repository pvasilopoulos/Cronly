-- Missed-schedule monitor: alert once when a scheduled run is overdue (never fired).
ALTER TABLE `Job`
  ADD COLUMN `missedAlertEnabled` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `missedAlertedAt` DATETIME(3) NULL;
