import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  // Graceful shutdown lets in-flight runs record a resumable state; never let it hang forever.
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.once(sig, () => {
      setTimeout(() => {
        new Logger('Worker').warn('Shutdown took too long — forcing exit (progress so far is kept).');
        process.exit(1);
      }, 20_000).unref();
    });
}

bootstrap().catch((e) => {
  new Logger('Worker').error(`Worker failed to start: ${e?.message ?? e}`);
  process.exit(1);
});
