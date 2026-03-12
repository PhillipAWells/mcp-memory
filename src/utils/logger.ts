/**
 * Structured logger for MCP Memory server
 *
 * Uses @pawells/logger with the built-in StderrTransport to ensure
 * logs write to stderr instead of stdout, preventing corruption
 * of the MCP protocol which communicates over stdio.
 */

import { Logger, LogLevel, StderrTransport } from '@pawells/logger';
import { config } from '../config.js';

const level = (config.server.logLevel as unknown as LogLevel) || LogLevel.INFO;

/**
 * Singleton logger instance, configured from environment variables.
 *
 * Log level is controlled by `LOG_LEVEL` (debug | info | warn | error | silent).
 * `silent` suppresses all output — useful in tests. When unset, defaults to `info`.
 */
export const logger = new Logger({
	service: 'mcp-memory',
	level,
	format: 'text',
	transport: new StderrTransport({ service: 'mcp-memory', level, format: 'text' }),
});
