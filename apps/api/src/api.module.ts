import type { Db } from '@code-trust/db';
import { type DynamicModule, Module } from '@nestjs/common';
import { ReposController } from './repos.controller.ts';
import { ReposService } from './repos.service.ts';
import { DB } from './tokens.ts';

@Module({ controllers: [ReposController], providers: [ReposService] })
export class ApiModule {}

/** The module with its database handle, which the caller owns and closes. */
export function apiModule(db: Db): DynamicModule {
  return { module: ApiModule, providers: [{ provide: DB, useValue: db }] };
}
