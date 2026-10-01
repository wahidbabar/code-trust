import { PACKAGE_NAME as ANALYZER } from '@code-trust/analyzer';
import { expect, test } from 'vitest';
import { PACKAGE_NAME } from './index.ts';

test('package resolves and exports its name', () => {
  expect(PACKAGE_NAME).toBe('@code-trust/worker');
});

test('workspace dependencies resolve to source without a build step', () => {
  expect(ANALYZER).toBe('@code-trust/analyzer');
});
