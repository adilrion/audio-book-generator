import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PythonPool } from '@app/pipeline';
import { APP_CONFIG, type AppConfig } from '../common/config.provider';

/** Small, lazily-started Python pool for quick API-side work (inspect, page previews, voices). */
@Injectable()
export class PythonService implements OnModuleDestroy {
  readonly pool: PythonPool;
  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.pool = new PythonPool(cfg, 1);
  }
  call<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    return this.pool.call<T>(method, params, { timeoutMs });
  }
  async onModuleDestroy() {
    await this.pool.shutdown();
  }
}
