import { expect, test } from 'vitest';
import { PACKAGE_NAME } from './index.ts';

test('package resolves and exports its name', () => {
  expect(PACKAGE_NAME).toBe('@code-trust/ingest');
});
