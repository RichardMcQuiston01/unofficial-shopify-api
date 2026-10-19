import {
  createMemorySessionStorage,
  type ConfigurationError,
  type Result,
  type SessionStorage,
} from '@richardmcquiston01/unofficial-shopify-api';
import { configFromEnv, type AppConfig, type AppContext } from '../../app.js';

// Replace the in-memory store with a durable one (see the README) before you deploy:
// sessions are lost on restart and not shared between instances.
const sessions: SessionStorage = createMemorySessionStorage();

/** Reads the environment once and fails loudly if a variable is missing. */
export function context(): AppContext {
  const config: Result<AppConfig, ConfigurationError> = configFromEnv(
    process.env
  );
  if (!config.ok) throw config.error;
  return { config: config.value, sessions };
}
