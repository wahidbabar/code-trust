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
  const target = new URL(url);
  return `${target.pathname.slice(1)} on ${target.host}`;
}
