-- Per-rule alert throttle / re-notify window.
ALTER TABLE `AlertRule`
  ADD COLUMN `muteSec` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `lastFiredAt` DATETIME(3) NULL;
