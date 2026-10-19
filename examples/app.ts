import {
  ConfigurationError,
  err,
  ok,
  type Result,
  type SessionStorage,
} from '@richardmcquiston01/unofficial-shopify-api';

/** Settings from the app's page in the Shopify Dev Dashboard. */
export interface AppConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  /** Public https URL of this app, for the OAuth redirect. */
  readonly appUrl: string;
  readonly apiVersion: string;
}

/** Everything the example handlers need. Swap the session store for a durable one. */
export interface AppContext {
  readonly config: AppConfig;
  readonly sessions: SessionStorage;
  /** Only set in tests. */
  readonly fetch?: typeof fetch;
}

/** Reads the configuration, failing with a message that names the missing variable. */
export function configFromEnv(
  env: Readonly<Record<string, string | undefined>>
): Result<AppConfig, ConfigurationError> {
  const required: readonly string[] = [
    'SHOPIFY_CLIENT_ID',
    'SHOPIFY_CLIENT_SECRET',
    'SHOPIFY_SCOPES',
    'APP_URL',
    'SHOPIFY_API_VERSION',
  ];
  for (const name of required) {
    if ((env[name] ?? '').trim() === '') {
      return err(
        new ConfigurationError(`Environment variable ${name} is not set.`)
      );
    }
  }
  return ok({
    clientId: env['SHOPIFY_CLIENT_ID'] ?? '',
    clientSecret: env['SHOPIFY_CLIENT_SECRET'] ?? '',
    scopes: (env['SHOPIFY_SCOPES'] ?? '')
      .split(',')
      .map((scope: string): string => scope.trim()),
    appUrl: env['APP_URL'] ?? '',
    apiVersion: env['SHOPIFY_API_VERSION'] ?? '',
  });
}

/** Options that route the library's HTTP through the context's `fetch`, if any. */
export function fetchOption(context: AppContext): { fetch?: typeof fetch } {
  return context.fetch === undefined ? {} : { fetch: context.fetch };
}
