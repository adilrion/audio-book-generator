import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { UserErrorFilter } from './common/error.filter';
import { configProvider } from './common/config.provider';
import { PrismaService } from './prisma/prisma.service';
import { ProjectsController } from './projects/projects.controller';
import { ProjectsService } from './projects/projects.service';
import { QueueService } from './queue/queue.service';
import { PythonService } from './system/python.service';
import { SystemController } from './system/system.controller';

@Module({
  controllers: [ProjectsController, SystemController],
  providers: [configProvider, PrismaService, QueueService, PythonService, ProjectsService, { provide: APP_FILTER, useClass: UserErrorFilter }],
})
export class AppModule {}
