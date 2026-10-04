// `pnpm --filter @code-trust/api seed`: writes the shared fixtures to the workspace database, so
// `dev` has something to serve. Run `pnpm --filter @code-trust/db migrate` first. Every write is
// an upsert, so running it again changes nothing.
//
// It runs under Node's type stripping, like migrate: nothing it imports uses decorators.
import { createPgDb } from '@code-trust/db/pg';
import { seedFixtures } from '@code-trust/db/testing';
import { repoFixture } from '@code-trust/shared/fixtures';
import { describeDatabase, localDatabaseUrl } from './local-database.ts';

const url = localDatabaseUrl();
console.log(`Seeding ${describeDatabase(url)}`);

const db = createPgDb(url);
try {
  await seedFixtures(db);
  console.log(`Seeded ${repoFixture.owner}/${repoFixture.name} (repo ${repoFixture.id}) and its survival rollups.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
