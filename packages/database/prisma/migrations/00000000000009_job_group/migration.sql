-- AlterTable: optional grouping label for the job list view.
ALTER TABLE "Job" ADD COLUMN "group" TEXT;

-- Helps group-by queries and the console's grouped list.
CREATE INDEX "Job_tenantId_group_idx" ON "Job"("tenantId", "group");
