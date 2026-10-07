import { GetParameterCommand, type GetParameterCommandOutput } from '@aws-sdk/client-ssm';
import { describe, expect, test, vi } from 'vitest';
import { ssmParameterLoader } from './aws.ts';
import { createHandler } from './handler.ts';
import { functionUrlEvent } from './testing.ts';

function fakeClient(output: Partial<GetParameterCommandOutput>) {
  const sent: GetParameterCommand[] = [];
  return {
    sent,
    send: vi.fn(async (command: GetParameterCommand) => {
      sent.push(command);
      return { $metadata: {}, ...output };
    }),
  };
}

describe('ssmParameterLoader', () => {
  test('reads the named parameter with decryption and returns its value', async () => {
    const client = fakeClient({ Parameter: { Value: 'postgres://u:p@example.invalid/db' } });
    const load = ssmParameterLoader(client, '/code-trust/database-url');
    await expect(load()).resolves.toBe('postgres://u:p@example.invalid/db');
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]).toBeInstanceOf(GetParameterCommand);
    expect(client.sent[0]?.input).toEqual({ Name: '/code-trust/database-url', WithDecryption: true });
  });

  test('a missing parameter name fails when the loader runs, not when it is built, and calls nothing', async () => {
    const client = fakeClient({});
    const load = ssmParameterLoader(client, undefined);
    await expect(load()).rejects.toThrow('DATABASE_URL_PARAMETER is not set');
    expect(client.send).not.toHaveBeenCalled();
  });

  test('a parameter with no value fails', async () => {
    await expect(ssmParameterLoader(fakeClient({ Parameter: {} }), '/x')()).rejects.toThrow('has no value');
    await expect(ssmParameterLoader(fakeClient({ Parameter: { Value: '' } }), '/x')()).rejects.toThrow('has no value');
  });

  test('through createHandler, a missing parameter name is a bare 500', async () => {
    const handler = createHandler({ loadDatabaseUrl: ssmParameterLoader(fakeClient({}), undefined), logger: false });
    const result = await handler(functionUrlEvent('GET', '/health'));
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body ?? '')).toEqual({ statusCode: 500, message: 'Internal server error' });
  });
});
