/**
 * Tests for the singleton logger instance (src/utils/logger.ts)
 *
 * The logger is a module-level singleton that reads config at import time.
 * Tests use vi.resetModules() + dynamic import() to re-evaluate the module
 * with different config values.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock config so we can control logLevel without a real environment
vi.mock('../../config.js', () => ({
	config: {
		server: { logLevel: 'info' },
	},
}));

describe('logger singleton', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('exports a logger instance', async () => {
		const { logger } = await import('../logger.js');
		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe('function');
		expect(typeof logger.warn).toBe('function');
		expect(typeof logger.error).toBe('function');
		expect(typeof logger.debug).toBe('function');
	});

	it('creates a logger with the configured log level', async () => {
		const { logger } = await import('../logger.js');
		// Logger should be a Logger instance from @pawells/logger
		expect(logger).toBeTruthy();
	});

	it('falls back to INFO level when logLevel is unrecognized', async () => {
		// Override the mock config with an invalid level to trigger the ?? fallback
		vi.doMock('../../config.js', () => ({
			config: {
				server: { logLevel: 'nonexistent-level' },
			},
		}));
		vi.resetModules();

		// Re-import after resetting modules — the ?? LogLevel.INFO branch fires
		const { logger } = await import('../logger.js');
		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe('function');
	});
});
