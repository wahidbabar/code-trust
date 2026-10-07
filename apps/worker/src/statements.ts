// Counts the statements a job sends. Every query crosses from Mumbai to Singapore, so this number
// is what a job costs in round trips. The database handles take no Kysely `log` option, so the
// count comes from a plugin, which works the same on the Neon and node-postgres dialects.
import type { Db } from '@code-trust/db';
import type { KyselyPlugin } from 'kysely';

export interface CountedDb {
  /** The same database, counting every statement it runs. */
  db: Db;
  readonly count: number;
}

export function countStatements(db: Db): CountedDb {
  let count = 0;
  const plugin: KyselyPlugin = {
    transformQuery: (args) => args.node,
    // Kysely calls transformResult once per executed statement. transformQuery would also run for
    // each subquery builder, and so overcount.
    transformResult: async (args) => {
      count += 1;
      return args.result;
    },
  };
  return {
    db: db.withPlugin(plugin),
    get count() {
      return count;
    },
  };
}
