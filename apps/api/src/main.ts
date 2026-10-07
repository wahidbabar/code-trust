// `pnpm --filter @code-trust/api dev`: the API on a local port, against the workspace database.
//
// It runs under tsx, not Node's type stripping, which cannot run decorators. It listens on PORT,
// else on CONDUCTOR_PORT, the port this Conductor workspace owns, and on loopback only.
import { createPgDb } from '@code-trust/db/pg';
import { createApp } from './app.ts';
import { describeDatabase, localDatabaseUrl } from './local-database.ts';

const url = localDatabaseUrl();
// Described before pg sees the URL: pg's own parse error would print a malformed one in full.
const target = describeDatabase(url);
const port = Number(process.env.PORT || process.env.CONDUCTOR_PORT || 3000);

const db = createPgDb(url);
const app = await createApp(db);
await app.listen(port, '127.0.0.1');
console.log(`Serving ${target} at http://127.0.0.1:${port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await db.destroy();
  });
}
