import { loadConfig, type AppConfig } from '@app/config';

export const APP_CONFIG = Symbol('APP_CONFIG');
export type { AppConfig };

export const configProvider = { provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() };
