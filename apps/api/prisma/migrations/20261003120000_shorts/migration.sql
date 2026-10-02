-- CreateTable
CREATE TABLE "Short" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "script" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "settings" JSONB NOT NULL,
    "projectId" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "snapshot" JSONB,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "durationSec" DOUBLE PRECISION,
    "renderedKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Short_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Short_createdAt_idx" ON "Short"("createdAt");

-- CreateIndex
CREATE INDEX "Short_projectId_idx" ON "Short"("projectId");

-- AddForeignKey
ALTER TABLE "Short" ADD CONSTRAINT "Short_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

