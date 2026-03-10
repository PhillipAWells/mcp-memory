/**
 * Structured logger for MCP Memory server
 *
 * Uses @pawells/logger with a custom StderrTransport to ensure
 * logs write to stderr instead of stdout, preventing corruption
 * of the MCP protocol which communicates over stdio.
 */

import { Logger, LogLevel, type ITransport, type ILogEntry } from '@pawells/logger';
import { config } from '../config.js';

/**
 * Custom transport that writes log entries to stderr.
 * Essential for MCP servers that communicate over stdio.
 */
class StderrTransport implements ITransport {
	private readonly config: { format?: 'json' | 'text' };

	constructor(config: { format?: 'json' | 'text' } = {}) {
		this.config = config;
	}

	public write(entry: ILogEntry): void {
		const format = this.config.format ?? 'text';
		const output = format === 'json'
			? JSON.stringify(entry)
			: this.formatText(entry);

		process.stderr.write(`${output}\n`);
	}

	private formatText(entry: ILogEntry): string {
		const nanosecondToMillisecond = 1_000_000_000;
		const timestampMs = Number(entry.timestamp) / nanosecondToMillisecond;
		const timestamp = new Date(timestampMs).toISOString();
		const level = entry.level.toUpperCase();
		const metadata = entry.metadata && Object.keys(entry.metadata).length > 0
			? ` ${JSON.stringify(entry.metadata)}`
			: '';

		return `${timestamp} ${level} [${entry.service}] ${entry.message}${metadata}`;
	}
}

/**
 * Wrapper logger that extends the base Logger to accept error objects
 * and convert them to metadata for proper serialization.
 */
class FlexibleLogger extends Logger {
	// eslint-disable-next-line require-await
	public async debug(message: string, metadata?: unknown): Promise<void> {
		const normalizedMetadata = this.normalizeMetadata(metadata);
		return super.debug(message, normalizedMetadata);
	}

	// eslint-disable-next-line require-await
	public async info(message: string, metadata?: unknown): Promise<void> {
		const normalizedMetadata = this.normalizeMetadata(metadata);
		return super.info(message, normalizedMetadata);
	}

	// eslint-disable-next-line require-await
	public async warn(message: string, metadata?: unknown): Promise<void> {
		const normalizedMetadata = this.normalizeMetadata(metadata);
		return super.warn(message, normalizedMetadata);
	}

	// eslint-disable-next-line require-await
	public async error(message: string, metadata?: unknown): Promise<void> {
		const normalizedMetadata = this.normalizeMetadata(metadata);
		return super.error(message, normalizedMetadata);
	}

	private normalizeMetadata(metadata: unknown): Record<string, unknown> | undefined {
		if (!metadata) return undefined;
		if (typeof metadata === 'object' && !Array.isArray(metadata)) {
			if (metadata instanceof Error) {
				return {
					error: metadata.message,
					stack: metadata.stack,
					name: metadata.name,
				};
			}
			return metadata as Record<string, unknown>;
		}
		return { value: metadata };
	}
}

/**
 * Singleton logger instance, configured from environment variables
 */
export const logger = new FlexibleLogger({
	service: 'mcp-memory',
	level: (config.server.logLevel as unknown as LogLevel) || LogLevel.INFO,
	transport: new StderrTransport({ format: 'text' }),
});
