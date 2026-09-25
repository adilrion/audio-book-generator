import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '@app/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const cfg = loadConfig();
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.enableCors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] });
  app.enableShutdownHooks();
  await app.listen(cfg.API_PORT, '127.0.0.1');
  new Logger('API').log(`API listening on http://localhost:${cfg.API_PORT}`);
}

bootstrap().catch((e) => {
  new Logger('API').error(`API failed to start: ${e?.message ?? e}`);
  process.exit(1);
});
