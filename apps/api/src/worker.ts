import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
}

bootstrap().catch((e) => {
  new Logger('Worker').error(`Worker failed to start: ${e?.message ?? e}`);
  process.exit(1);
});
