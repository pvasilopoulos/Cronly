-- Add TELEGRAM to the notification channel type enum.
ALTER TABLE `NotificationChannel`
  MODIFY `type` ENUM('EMAIL', 'SLACK', 'WEBHOOK', 'TELEGRAM') NOT NULL;

-- Scheduled tenant-wide maintenance windows (suppress scheduling while active).
CREATE TABLE `MaintenanceWindow` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NULL,
    `startsAt` DATETIME(3) NOT NULL,
    `endsAt` DATETIME(3) NOT NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `MaintenanceWindow_tenantId_idx`(`tenantId`),
    INDEX `MaintenanceWindow_tenantId_startsAt_endsAt_idx`(`tenantId`, `startsAt`, `endsAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `MaintenanceWindow` ADD CONSTRAINT `MaintenanceWindow_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
