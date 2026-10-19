export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export type LogContext = Readonly<Record<string, unknown>>;

/**
 * Minimal logger contract. Implementations must never receive access tokens
 * or other secrets; the library does not pass them.
 */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

const levelOrder: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const noop = (): void => undefined;

/** Logger that discards everything. This is the library default. */
export const noopLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

/** Creates a logger that writes to `console`, filtered by `level`. */
export function createConsoleLogger(level: LogLevel = 'info'): Logger {
  const threshold: number = levelOrder[level];
  const emit =
    (
      severity: Exclude<LogLevel, 'silent'>,
      write: (...args: unknown[]) => void
    ) =>
    (message: string, context?: LogContext): void => {
      if (levelOrder[severity] < threshold) return;
      if (context === undefined) {
        write(`[shopify:${severity}] ${message}`);
      } else {
        write(`[shopify:${severity}] ${message}`, context);
      }
    };
  return {
    debug: emit('debug', console.debug),
    info: emit('info', console.info),
    warn: emit('warn', console.warn),
    error: emit('error', console.error),
  };
}
