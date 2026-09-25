-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'EXTRACTING', 'CLEANING', 'ANALYZING', 'GENERATING_AUDIO', 'PREPARING_VIDEO', 'RENDERING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "estimatedWords" INTEGER NOT NULL,
    "title" TEXT,
    "author" TEXT,
    "likelyScanned" BOOLEAN NOT NULL DEFAULT false,
    "hasToc" BOOLEAN NOT NULL DEFAULT false,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Page" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "snapshot" JSONB,
    "analysisKey" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "durationSec" DOUBLE PRECISION,
    "outputs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chapter" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "pageStart" INTEGER NOT NULL,
    "pageEnd" INTEGER NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "Chapter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Paragraph" (
    "id" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "pageStart" INTEGER NOT NULL,
    "pageEnd" INTEGER NOT NULL,
    "regions" JSONB NOT NULL,

    CONSTRAINT "Paragraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sentence" (
    "id" TEXT NOT NULL,
    "paragraphId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "narration" TEXT NOT NULL,
    "regions" JSONB NOT NULL,

    CONSTRAINT "Sentence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioChunk" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "chapterIndex" INTEGER NOT NULL,
    "file" TEXT NOT NULL,
    "durationSec" DOUBLE PRECISION NOT NULL,
    "sampleRate" INTEGER NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "voice" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudioChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimelineSegment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "sentenceKey" TEXT NOT NULL,
    "chapterIndex" INTEGER NOT NULL,
    "page" INTEGER NOT NULL,
    "start" DOUBLE PRECISION NOT NULL,
    "end" DOUBLE PRECISION NOT NULL,
    "rects" JSONB NOT NULL,

    CONSTRAINT "TimelineSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenderJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "queueJobId" TEXT,
    "force" BOOLEAN NOT NULL DEFAULT false,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "RenderJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingStep" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "chapterIndex" INTEGER,
    "message" TEXT,
    "error" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProcessingStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Document_hash_key" ON "Document"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "Page_documentId_number_key" ON "Page"("documentId", "number");

-- CreateIndex
CREATE INDEX "Project_createdAt_idx" ON "Project"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Chapter_projectId_index_key" ON "Chapter"("projectId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "Paragraph_chapterId_index_key" ON "Paragraph"("chapterId", "index");

-- CreateIndex
CREATE INDEX "Sentence_key_idx" ON "Sentence"("key");

-- CreateIndex
CREATE UNIQUE INDEX "AudioChunk_projectId_chapterIndex_key" ON "AudioChunk"("projectId", "chapterIndex");

-- CreateIndex
CREATE INDEX "TimelineSegment_projectId_start_idx" ON "TimelineSegment"("projectId", "start");

-- CreateIndex
CREATE INDEX "RenderJob_projectId_createdAt_idx" ON "RenderJob"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingStep_projectId_key_key" ON "ProcessingStep"("projectId", "key");

-- AddForeignKey
ALTER TABLE "Page" ADD CONSTRAINT "Page_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chapter" ADD CONSTRAINT "Chapter_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Paragraph" ADD CONSTRAINT "Paragraph_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sentence" ADD CONSTRAINT "Sentence_paragraphId_fkey" FOREIGN KEY ("paragraphId") REFERENCES "Paragraph"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioChunk" ADD CONSTRAINT "AudioChunk_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineSegment" ADD CONSTRAINT "TimelineSegment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingStep" ADD CONSTRAINT "ProcessingStep_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
