/**
 * Structured logger for MCP Memory server
 *
 * Uses @pawells/logger with the built-in StderrTransport to ensure
 * logs write to stderr instead of stdout, preventing corruption
 * of the MCP protocol which communicates over stdio.
 */

import { Logger, LogLevel, StderrTransport } from '@pawells/logger';
import { config } from '../config.js';

/**
 * Map configuration log level string to LogLevel enum value.
 * Configuration is validated by Zod, so the config.server.logLevel is guaranteed
 * to be one of these values. This mapping ensures type safety without unsafe casts.
 */
const levelMap: Record<string, LogLevel> = {
	debug: LogLevel.DEBUG,
	info: LogLevel.INFO,
	warn: LogLevel.WARN,
	error: LogLevel.ERROR,
	silent: LogLevel.SILENT,
};

const level = levelMap[config.server.logLevel] ?? LogLevel.INFO;

/**
 * Singleton logger instance, configured from environment variables.
 *
 * Log level is controlled by `LOG_LEVEL` (debug | info | warn | error | silent).
 * `silent` suppresses all output — useful in tests. When unset, defaults to `info`.
 *
 * @example
 * ```typescript
 * import { logger } from './utils/logger.js';
 * logger.info('Server starting...');
 * logger.warn('Cache miss on embedding lookup');
 * logger.error('Failed to connect to Qdrant', error);
 * logger.debug('Detailed diagnostic information');
 * ```
 */
export const logger = new Logger({
	service: 'mcp-memory',
	level,
	format: 'text',
	transport: new StderrTransport({ service: 'mcp-memory', level, format: 'text' }),
});
