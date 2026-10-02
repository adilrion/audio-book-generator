-- AlterTable
ALTER TABLE "Short" ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "thumbnail" JSONB;

