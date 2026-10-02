import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { UserErrorFilter } from './common/error.filter';
import { configProvider } from './common/config.provider';
import { ArchiveClient } from './library/archive';
import { LibraryController } from './library/library.controller';
import { ARCHIVE_CLIENT, LibraryService } from './library/library.service';
import { PrismaService } from './prisma/prisma.service';
import { ProjectsController } from './projects/projects.controller';
import { PublishController } from './publish/publish.controller';
import { PublishService } from './publish/publish.service';
import { ProjectsService } from './projects/projects.service';
import { QueueService } from './queue/queue.service';
import { ShortsController } from './shorts/shorts.controller';
import { ShortsService } from './shorts/shorts.service';
import { PerformanceService } from './system/performance.service';
import { PythonService } from './system/python.service';
import { SystemController } from './system/system.controller';
import { VoicePreviewController } from './system/voice-preview.controller';

@Module({
  controllers: [ProjectsController, LibraryController, PublishController, ShortsController, SystemController, VoicePreviewController],
  providers: [configProvider, PrismaService, QueueService, PythonService, PerformanceService, ProjectsService, PublishService, LibraryService, ShortsService, { provide: ARCHIVE_CLIENT, useFactory: () => new ArchiveClient() }, { provide: APP_FILTER, useClass: UserErrorFilter }],
})
export class AppModule {}
