-- Per-job overlap policy: what to do when a previous run of the same job is
-- still active (QUEUED/RUNNING) at the next scheduled tick.
ALTER TABLE `Job`
  ADD COLUMN `overlapPolicy` ENUM('ALLOW', 'SKIP', 'QUEUE') NOT NULL DEFAULT 'ALLOW';
