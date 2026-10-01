// The node-postgres dialect: local Postgres, CI and the migrate script. The lane that first runs
// on Lambda adds Neon's serverless driver as a second dialect next to this file; the queries are
// written against Kysely<Database> and do not change.
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './database.ts';

export interface PgOptions {
  /** Puts this schema first on the search path. Tests use it to work in a scratch schema. */
  schema?: string;
}

export function createPgDb(connectionString: string, options: PgOptions = {}): Kysely<Database> {
  const { schema } = options;
  if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`"${schema}" is not a usable schema name: lowercase letters, digits and underscores only.`);
  }
  const pool = new Pool({
    connectionString,
    ...(schema === undefined ? {} : { options: `-c search_path=${schema}` }),
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
