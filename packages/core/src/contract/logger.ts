// The logger contract and its console default, unchanged from 4.1
// (`legacy-src/shared/types.ts:525-545`).

/**
 * Logger interface compatible with Winston and other loggers
 */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  child(options: Record<string, unknown>): Logger;
}

/**
 * Default console logger implementation
 */
export const consoleLogger: Logger = {
  info: (message, meta) => console.log(`[INFO] ${message}`, meta ?? ""),
  warn: (message, meta) => console.warn(`[WARN] ${message}`, meta ?? ""),
  error: (message, meta) => console.error(`[ERROR] ${message}`, meta ?? ""),
  debug: (message, meta) => console.debug(`[DEBUG] ${message}`, meta ?? ""),
  child: () => consoleLogger,
};
