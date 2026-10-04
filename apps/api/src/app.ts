import type { Db } from '@code-trust/db';
import type { INestApplication, LoggerService, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { apiModule } from './api.module.ts';

export interface CreateAppOptions {
  /** Nest's logger. Unset keeps Nest's default; tests pass false. */
  logger?: LoggerService | LogLevel[] | false;
}

/**
 * The API, initialized but not listening: the local server calls listen() on it, and the Lambda
 * lane wraps it once per cold start. The caller owns the database handle and closes it.
 */
export async function createApp(db: Db, options: CreateAppOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(apiModule(db), new ExpressAdapter(), {
    // Otherwise a bootstrap error calls process.abort(), where a caller should get the error.
    abortOnError: false,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  await app.init();
  return app;
}
