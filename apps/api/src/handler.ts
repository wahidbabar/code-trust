// The API behind a Lambda Function URL: createApp from app.ts, built once per execution
// environment and fed Function URL events (payload format 2.0) through serverless-express.
//
// CORS is not here, and Nest never calls enableCors: the Function URL adds the CORS headers, so
// the rule lives in ApiStack's template, and a second set from Nest would break browsers.
import type { Db } from '@code-trust/db';
import { createNeonDb } from '@code-trust/db/neon';
import { configure } from '@codegenie/serverless-express';
import { ConsoleLogger, type LoggerService } from '@nestjs/common';
import type { APIGatewayProxyStructuredResultV2, Context, LambdaFunctionURLEvent } from 'aws-lambda';
import { createApp } from './app.ts';

/** Each Neon query fails after this long, so a hung one becomes a 500 well inside the function's timeout. */
export const API_QUERY_TIMEOUT_MS = 5_000;

export type FunctionUrlResult = APIGatewayProxyStructuredResultV2;
export type FunctionUrlHandler = (event: LambdaFunctionURLEvent, context?: Context) => Promise<FunctionUrlResult>;

export interface HandlerDeps {
  /** Returns the database URL. Called on the first request, and again after a start that failed. */
  loadDatabaseUrl(): Promise<string>;
  /** Builds the database handle from the URL. Defaults to Neon over HTTP; tests pass node-postgres. */
  connect?: (url: string) => Db;
  /** Nest's logger, also used for a failed start. Defaults to errors and warnings as JSON lines. */
  logger?: LoggerService | false;
}

const connectNeon = (url: string): Db => createNeonDb(url, { queryTimeoutMs: API_QUERY_TIMEOUT_MS });

// serverless-express answers through its promise in its default resolution mode. Its Handler type
// still lists Lambda's callback, which it ignores then, so the type is narrowed here.
type Proxy = (event: LambdaFunctionURLEvent, context?: Context) => Promise<FunctionUrlResult>;

// The body Nest sends for any unhandled error, so the dashboard sees one shape of 500.
function internalServerError(): FunctionUrlResult {
  return {
    statusCode: 500,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ statusCode: 500, message: 'Internal server error' }),
    isBase64Encoded: false,
  };
}

/**
 * A Function URL handler around createApp. The first request loads the URL, builds the handle and
 * the app; later requests reuse them. A start that fails is not kept: that request gets a 500 that
 * says nothing about the cause, and the next request starts again.
 */
export function createHandler(deps: HandlerDeps): FunctionUrlHandler {
  const connect = deps.connect ?? connectNeon;
  const logger = deps.logger ?? new ConsoleLogger({ json: true, logLevels: ['error', 'warn'] });
  let ready: Promise<Proxy> | undefined;

  async function start(): Promise<Proxy> {
    const db = connect(await deps.loadDatabaseUrl());
    let app: Awaited<ReturnType<typeof createApp>>;
    try {
      app = await createApp(db, { logger });
    } catch (error) {
      await db.destroy();
      throw error;
    }
    return configure({
      app: app.getHttpAdapter().getInstance(),
      // Its default sends error.stack as the body whenever NODE_ENV is development.
      respondWithErrors: false,
      logSettings: { level: 'error' },
    }) as unknown as Proxy;
  }

  return async (event, context) => {
    if (ready === undefined) {
      const attempt = start();
      ready = attempt;
      attempt.catch(() => {
        if (ready === attempt) ready = undefined;
      });
    }
    let proxy: Proxy;
    try {
      proxy = await ready;
    } catch (error) {
      // Name and message only. The loader's errors fire before the URL is read, and createNeonDb's
      // are fixed text, so neither carries it.
      const cause = error instanceof Error ? `${error.name}: ${error.message}` : 'a non-Error value';
      if (logger) logger.error(`The API failed to start: ${cause}`, 'createHandler');
      return internalServerError();
    }
    return proxy(event, context);
  };
}
