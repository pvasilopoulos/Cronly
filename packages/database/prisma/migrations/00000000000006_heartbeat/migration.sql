-- CreateEnum
CREATE TYPE "HeartbeatState" AS ENUM ('OK', 'MISSING');

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "heartbeatAlertedAt" TIMESTAMP(3),
ADD COLUMN     "heartbeatEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "heartbeatGraceSec" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "heartbeatIntervalSec" INTEGER,
ADD COLUMN     "heartbeatState" "HeartbeatState" NOT NULL DEFAULT 'OK',
ADD COLUMN     "heartbeatToken" TEXT,
ADD COLUMN     "lastPingAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Job_heartbeatToken_key" ON "Job"("heartbeatToken");

