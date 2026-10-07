// The API function's environment variable names. ApiStack imports these from '@code-trust/api/env',
// so the stack and the handler cannot drift apart.
export const API_ENV = {
  /** Name of the SSM SecureString that holds the database URL, with its leading slash. */
  databaseUrlParameter: 'DATABASE_URL_PARAMETER',
} as const;
