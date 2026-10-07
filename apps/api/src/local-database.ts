// For the local scripts (dev and seed) only: createApp takes its handle from the caller and reads
// no environment. The package scripts pass --env-file-if-exists for the workspace's
// .env.workspace, so a DATABASE_URL already in the environment wins and `.env` is never loaded.

export function localDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'DATABASE_URL is not set. In a Conductor workspace it comes from .env.workspace (run the setup script). ' +
        'Anywhere else, export it first.',
    );
    process.exit(1);
  }
  return url;
}

/** Database and host only: the URL carries a password. */
export function describeDatabase(url: string): string {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    // Node's ERR_INVALID_URL keeps the whole URL on `input`, so it is dropped here, as in db's migrate.
    throw new Error('DATABASE_URL is not a valid URL. Its value is not printed, since it holds a password.');
  }
  return `${target.pathname.slice(1)} on ${target.host}`;
}
