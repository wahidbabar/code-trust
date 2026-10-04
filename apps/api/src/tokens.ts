// The one injection token for the database handle. Local runs and tests provide a node-postgres
// handle under it; the Lambda lane provides a Neon one, and nothing else changes.
export const DB = Symbol('code-trust database');
