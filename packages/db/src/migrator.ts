// Applies migrations/*.sql in file-name order. Kysely's Migrator does the bookkeeping: it takes an
// advisory lock, runs the pending files in one transaction and records them in kysely_migration.
//
// Migrations only move forward. A mistake is fixed by a new file, never by editing an applied one.
import { readdir, readFile } from 'node:fs/promises';
import { type Kysely, sql } from 'kysely';
import { type Migration, Migrator } from 'kysely/migration';
import type { Database } from './database.ts';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

export interface MigrateOptions {
  /**
   * The schema that holds the tables. It must be the first schema on the connection's search
   * path, because the SQL files do not qualify table names.
   */
  schema?: string;
}

export interface MigrateResult {
  /** Names of the migrations this run applied, in order. Empty when the schema was up to date. */
  applied: string[];
}

export async function loadMigrations(): Promise<Record<string, Migration>> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
  const migrations: Record<string, Migration> = {};
  for (const file of files) {
    const text = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
    migrations[file.slice(0, -'.sql'.length)] = {
      // No bind parameters, so the driver sends the file as one simple query and Postgres accepts
      // several statements in it.
      up: async (db) => {
        await sql.raw(text).execute(db);
      },
    };
  }
  return migrations;
}

export async function migrateToLatest(db: Kysely<Database>, options: MigrateOptions = {}): Promise<MigrateResult> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: loadMigrations },
    // Named explicitly: without it the Migrator looks for its tables in every schema, finds the
    // ones in "public" and skips creating them in a scratch schema.
    migrationTableSchema: options.schema ?? 'public',
  });
  const { error, results } = await migrator.migrateToLatest();
  const applied = (results ?? []).filter((result) => result.status === 'Success').map((r) => r.migrationName);
  if (error) {
    const failed = results?.find((result) => result.status === 'Error')?.migrationName;
    throw new Error(`Migration ${failed ?? '(setup)'} failed and was rolled back.`, { cause: error });
  }
  return { applied };
}
