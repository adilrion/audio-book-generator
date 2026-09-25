import { Module } from '@nestjs/common';
import { configProvider } from '../common/config.provider';
import { PrismaService } from '../prisma/prisma.service';
import { ProcessingWorker } from './processor';

@Module({ providers: [configProvider, PrismaService, ProcessingWorker] })
export class WorkerModule {}
