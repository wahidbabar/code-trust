// A database URL carries a password, so nothing here ever puts the value in an error or a log line.
// Node's own ERR_INVALID_URL keeps the whole input on `error.input`, and the Neon driver echoes the
// connection string in its invalid-URL error, so the URL is checked here before either sees it.

export const INVALID_DATABASE_URL =
  'DATABASE_URL is not a valid URL. Its value is not printed, since it holds a password.';

/** Parses a database URL, throwing a fixed message that never contains the value. */
export function parseDatabaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The original error is dropped on purpose: its `input` is the URL.
    throw new Error(INVALID_DATABASE_URL);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must start with postgres:// or postgresql://. Its value is not printed.');
  }
  return url;
}

/** Replaces the URL, its user and its password, raw or percent-decoded, wherever they appear in `text`. */
export function redactSecrets(text: string, url: URL): string {
  const secrets = new Set<string>([url.href]);
  for (const part of [url.username, url.password]) {
    if (part === '') continue;
    secrets.add(part);
    try {
      secrets.add(decodeURIComponent(part));
    } catch {
      // A malformed escape cannot appear decoded anywhere, so the raw form is enough.
    }
  }
  let redacted = text;
  // Longest first, so the URL goes before the password inside it.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join('***');
  }
  return redacted;
}
