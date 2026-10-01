// `pnpm --filter @code-trust/db migrate`: brings the database at DATABASE_URL up to date.
//
// The package script passes --env-file-if-exists for the workspace's .env.workspace, so in a
// Conductor workspace this targets the workspace database with no setup. A DATABASE_URL already in
// the environment wins, which is how a human points it at Neon. `.env` is never loaded.
import { migrateToLatest } from './migrator.ts';
import { createPgDb } from './pg.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    'DATABASE_URL is not set. In a Conductor workspace it comes from .env.workspace (run the setup script). ' +
      'Anywhere else, export it before running migrate.',
  );
  process.exit(1);
}

// Host and database only: the URL carries a password.
const target = new URL(url);
console.log(`Migrating ${target.pathname.slice(1)} on ${target.host}`);

const db = createPgDb(url);
try {
  const { applied } = await migrateToLatest(db);
  if (applied.length === 0) console.log('Nothing to apply: the schema is up to date.');
  for (const name of applied) console.log(`Applied ${name}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
