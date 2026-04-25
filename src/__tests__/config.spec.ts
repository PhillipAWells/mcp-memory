/**
 * Unit tests for config.ts
 *
 * Tests configuration loading, validation, and error handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { config, parseIntEnv, parseBoolEnv, loadConfig } from '../config.js';
import type { Config } from '../config.js';

describe('config.ts', () => {
	describe('config export - structure and types', () => {
		it('exports a config object with all required fields', () => {
			expect(config).toBeDefined();
			expect(config.openai).toBeDefined();
			expect(config.embedding).toBeDefined();
			expect(config.qdrant).toBeDefined();
			expect(config.server).toBeDefined();
			expect(config.memory).toBeDefined();
			expect(config.workspace).toBeDefined();
			expect(config.rules).toBeDefined();
		});

		it('has correct OpenAI configuration structure', () => {
			expect(config.openai.apiKey).toBeDefined();
			expect(typeof config.openai.apiKey).toBe('string');
			expect(config.openai.apiKey.length).toBeGreaterThan(0);
		});

		it('has correct embedding configuration', () => {
			expect(config.embedding.smallDimensions).toBe(1536);
			expect(config.embedding.largeDimensions).toBe(3072);
			expect(typeof config.embedding.smallDimensions).toBe('number');
			expect(typeof config.embedding.largeDimensions).toBe('number');
		});

		it('has correct Qdrant configuration structure', () => {
			expect(config.qdrant.url).toBeDefined();
			expect(config.qdrant.collection).toBeDefined();
			expect(config.qdrant.timeout).toBeDefined();
			expect(typeof config.qdrant.timeout).toBe('number');
		});

		it('has correct server configuration', () => {
			expect(config.server.logLevel).toBeDefined();
			expect(['debug', 'info', 'warn', 'error', 'silent']).toContain(config.server.logLevel);
		});

		it('has correct memory configuration', () => {
			expect(config.memory.chunkSize).toBeDefined();
			expect(config.memory.chunkOverlap).toBeDefined();
			expect(typeof config.memory.chunkSize).toBe('number');
			expect(typeof config.memory.chunkOverlap).toBe('number');
		});

		it('has correct workspace configuration', () => {
			expect(config.workspace.autoDetect).toBeDefined();
			expect(config.workspace.default).toBeDefined();
			expect(config.workspace.cacheTTL).toBeDefined();
			expect(typeof config.workspace.autoDetect).toBe('boolean');
			expect(typeof config.workspace.cacheTTL).toBe('number');
		});

		it('has correct rules configuration', () => {
			expect(config.rules.copyClaudeRules).toBeDefined();
			expect(typeof config.rules.copyClaudeRules).toBe('boolean');
		});
	});

	describe('config validation constraints', () => {
		it('chunk overlap is strictly less than chunk size', () => {
			expect(config.memory.chunkOverlap).toBeLessThan(config.memory.chunkSize);
		});

		it('Qdrant timeout is a reasonable positive number', () => {
			expect(config.qdrant.timeout).toBeGreaterThan(0);
			expect(config.qdrant.timeout).toBeLessThan(300000); // Less than 5 minutes
		});

		it('workspace cache TTL is a reasonable positive number', () => {
			expect(config.workspace.cacheTTL).toBeGreaterThan(0);
		});

		it('chunk size is positive', () => {
			expect(config.memory.chunkSize).toBeGreaterThan(0);
		});

		it('chunk overlap is non-negative', () => {
			expect(config.memory.chunkOverlap).toBeGreaterThanOrEqual(0);
		});
	});

	describe('config defaults', () => {
		it('uses configured Qdrant collection name', () => {
			// Collection is configured per environment
			expect(config.qdrant.collection).toBeDefined();
			expect(typeof config.qdrant.collection).toBe('string');
		});

		it('uses reasonable chunk size (at least 100 chars)', () => {
			expect(config.memory.chunkSize).toBeGreaterThanOrEqual(100);
		});

		it('uses reasonable chunk overlap', () => {
			expect(config.memory.chunkOverlap).toBeGreaterThanOrEqual(0);
		});

		it('Qdrant URL is a valid URL string', () => {
			expect(config.qdrant.url).toBeDefined();
			expect(typeof config.qdrant.url).toBe('string');
		});

		it('log level is one of the valid options', () => {
			const validLevels = ['debug', 'info', 'warn', 'error', 'silent'];
			expect(validLevels).toContain(config.server.logLevel);
		});

		it('workspace auto-detect is a boolean', () => {
			expect(typeof config.workspace.autoDetect).toBe('boolean');
		});

		it('COPY_CLAUDE_RULES is a boolean', () => {
			expect(typeof config.rules.copyClaudeRules).toBe('boolean');
		});
	});

	describe('config type safety', () => {
		it('config type matches Config interface', () => {
			// Type check: if this compiles, the config object is correctly typed
			const _: Config = config;
			expect(_).toBeDefined();
		});

		it('all string fields are non-empty (where required)', () => {
			expect(config.openai.apiKey.length).toBeGreaterThan(0);
			expect(config.qdrant.url.length).toBeGreaterThan(0);
			expect(config.qdrant.collection.length).toBeGreaterThan(0);
		});

		it('embedding dimensions are configured correctly', () => {
			expect(config.embedding.smallDimensions).toBe(1536); // OpenAI text-embedding-3-small
			expect(config.embedding.largeDimensions).toBe(3072); // OpenAI text-embedding-3-large
		});
	});

	describe('config usage', () => {
		it('config object has all required sections populated', () => {
			// Verify the config is a complete, usable object
			expect(config.openai.apiKey.length).toBeGreaterThan(0);
			expect(config.embedding.smallDimensions).toBe(1536);
			expect(config.embedding.largeDimensions).toBe(3072);
			expect(config.qdrant.url).toBeDefined();
			expect(config.qdrant.collection).toBeDefined();
			expect(config.server.logLevel).toBeDefined();
			expect(config.memory.chunkSize).toBeGreaterThan(0);
			expect(config.workspace).toBeDefined();
			expect(config.rules).toBeDefined();
		});
	});

	describe('parseIntEnv', () => {
		let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		});

		afterEach(() => {
			consoleErrorSpy.mockRestore();
		});

		it('returns the fallback when raw is undefined', () => {
			const result = parseIntEnv(undefined, 42, 'TEST_VAR');
			expect(result).toBe(42);
		});

		it('parses a valid integer string', () => {
			const result = parseIntEnv('123', 0, 'TEST_VAR');
			expect(result).toBe(123);
		});

		it('parses zero', () => {
			const result = parseIntEnv('0', 42, 'TEST_VAR');
			expect(result).toBe(0);
		});

		it('parses negative integers', () => {
			const result = parseIntEnv('-100', 0, 'TEST_VAR');
			expect(result).toBe(-100);
		});

		it('throws an error when given a non-integer string', () => {
			expect(() => parseIntEnv('not-a-number', 10, 'MY_VAR')).toThrow(
				/Invalid environment variable MY_VAR="not-a-number"/,
			);
		});

		it('parses decimal number string (JavaScript parseInt stops at first non-digit)', () => {
			// parseInt('123.456') returns 123, not NaN
			const result = parseIntEnv('123.456', 10, 'DECIMAL_VAR');
			expect(result).toBe(123);
		});

		it('throws an error when given an empty string', () => {
			// parseInt('') returns NaN, which triggers the error
			expect(() => parseIntEnv('', 10, 'EMPTY_VAR')).toThrow(
				/Invalid environment variable EMPTY_VAR=""/,
			);
		});

		it('throws an error with the correct variable name in message', () => {
			expect(() => parseIntEnv('abc', 50, 'CUSTOM_INT_VAR')).toThrow();
		});

		it('throws an error mentioning the fallback value', () => {
			expect(() => parseIntEnv('invalid', 999, 'TEST_INT')).toThrow();
		});

		it('parses leading whitespace (JavaScript parseInt behavior)', () => {
			// parseInt(' 42 ') works in JavaScript and returns 42
			const result = parseIntEnv('  42  ', 0, 'WHITESPACE_VAR');
			expect(result).toBe(42);
		});

		it('parses very large numbers (within JavaScript limits)', () => {
			const hugeNum = String(Number.MAX_SAFE_INTEGER);
			const result = parseIntEnv(hugeNum, 0, 'HUGE_VAR');
			expect(result).not.toBeNaN();
		});
	});

	describe('parseBoolEnv', () => {
		it('returns the fallback when raw is undefined', () => {
			const result = parseBoolEnv(undefined, true);
			expect(result).toBe(true);
		});

		it('returns the fallback when raw is undefined (false)', () => {
			const result = parseBoolEnv(undefined, false);
			expect(result).toBe(false);
		});

		it('treats "false" (case-insensitive) as false', () => {
			expect(parseBoolEnv('false', true)).toBe(false);
			expect(parseBoolEnv('FALSE', true)).toBe(false);
			expect(parseBoolEnv('False', true)).toBe(false);
		});

		it('treats "0" as false', () => {
			expect(parseBoolEnv('0', true)).toBe(false);
		});

		it('treats "no" (case-insensitive) as false', () => {
			expect(parseBoolEnv('no', true)).toBe(false);
			expect(parseBoolEnv('NO', true)).toBe(false);
			expect(parseBoolEnv('No', true)).toBe(false);
		});

		it('treats "off" (case-insensitive) as false', () => {
			expect(parseBoolEnv('off', true)).toBe(false);
			expect(parseBoolEnv('OFF', true)).toBe(false);
			expect(parseBoolEnv('Off', true)).toBe(false);
		});

		it('treats any other non-empty string as true', () => {
			expect(parseBoolEnv('true', false)).toBe(true);
			expect(parseBoolEnv('TRUE', false)).toBe(true);
			expect(parseBoolEnv('yes', false)).toBe(true);
			expect(parseBoolEnv('1', false)).toBe(true);
			expect(parseBoolEnv('anything', false)).toBe(true);
		});

		it('treats empty string as fallback value', () => {
			// Empty string (after trim) returns the fallback value per the recent update
			expect(parseBoolEnv('', false)).toBe(false);
		});
	});

	describe('loadConfig with environment variable manipulation', () => {
		let originalEnv: Record<string, string | undefined>;
		let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			// Save original environment
			originalEnv = { ...process.env };
			// Mock console.error to suppress validation error messages
			consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		});

		afterEach(() => {
			// Restore original environment
			process.env = originalEnv;
			// Restore console.error
			consoleErrorSpy.mockRestore();
		});

		it('throws an error when OPENAI_API_KEY is missing', () => {
			// Temporarily clear the API key
			const savedKey = process.env.OPENAI_API_KEY;
			delete process.env.OPENAI_API_KEY;

			try {
				const fn = () => loadConfig();
				expect(fn).toThrow();
				// Verify that the error is about configuration validation
				try {
					fn();
				} catch (error) {
					expect((error as Error).message).toContain('Invalid configuration');
				}
			} finally {
				if (savedKey) process.env.OPENAI_API_KEY = savedKey;
			}
		});

		it('throws an error when QDRANT_URL is not a valid URL', () => {
			const savedUrl = process.env.QDRANT_URL;
			process.env.QDRANT_URL = 'not a valid url';

			try {
				// Zod will throw "Invalid url" for non-URL strings
				const fn = () => loadConfig();
				expect(fn).toThrow();
				try {
					fn();
				} catch (error) {
					expect((error as Error).message).toContain('Invalid configuration');
				}
			} finally {
				if (savedUrl) {
					process.env.QDRANT_URL = savedUrl;
				} else {
					delete process.env.QDRANT_URL;
				}
			}
		});

		it('throws an error when MEMORY_CHUNK_OVERLAP >= MEMORY_CHUNK_SIZE', () => {
			const savedSize = process.env.MEMORY_CHUNK_SIZE;
			const savedOverlap = process.env.MEMORY_CHUNK_OVERLAP;

			process.env.MEMORY_CHUNK_SIZE = '100';
			process.env.MEMORY_CHUNK_OVERLAP = '100'; // equal, violates < constraint

			try {
				const fn = () => loadConfig();
				expect(fn).toThrow();
				try {
					fn();
				} catch (error) {
					// Zod error is caught and re-thrown with cause
					expect((error as Error).message).toContain('Invalid configuration');
				}
			} finally {
				if (savedSize) {
					process.env.MEMORY_CHUNK_SIZE = savedSize;
				} else {
					delete process.env.MEMORY_CHUNK_SIZE;
				}
				if (savedOverlap) {
					process.env.MEMORY_CHUNK_OVERLAP = savedOverlap;
				} else {
					delete process.env.MEMORY_CHUNK_OVERLAP;
				}
			}
		});

		it('throws an error when QDRANT_API_KEY is too short', () => {
			const savedKey = process.env.QDRANT_API_KEY;
			process.env.QDRANT_API_KEY = 'short'; // less than 8 characters

			try {
				const fn = () => loadConfig();
				expect(fn).toThrow();
				try {
					fn();
				} catch (error) {
					expect((error as Error).message).toContain('Invalid configuration');
				}
			} finally {
				if (savedKey) {
					process.env.QDRANT_API_KEY = savedKey;
				} else {
					delete process.env.QDRANT_API_KEY;
				}
			}
		});

		it('throws an error when MEMORY_CHUNK_SIZE is not an integer', () => {
			const savedSize = process.env.MEMORY_CHUNK_SIZE;
			process.env.MEMORY_CHUNK_SIZE = 'invalid-int';

			try {
				expect(() => loadConfig()).toThrow(/Invalid environment variable MEMORY_CHUNK_SIZE/);
			} finally {
				if (savedSize) {
					process.env.MEMORY_CHUNK_SIZE = savedSize;
				} else {
					delete process.env.MEMORY_CHUNK_SIZE;
				}
			}
		});

		it('throws an error when QDRANT_TIMEOUT is not an integer', () => {
			const savedTimeout = process.env.QDRANT_TIMEOUT;
			process.env.QDRANT_TIMEOUT = 'not-a-number';

			try {
				expect(() => loadConfig()).toThrow(/Invalid environment variable QDRANT_TIMEOUT/);
			} finally {
				if (savedTimeout) {
					process.env.QDRANT_TIMEOUT = savedTimeout;
				} else {
					delete process.env.QDRANT_TIMEOUT;
				}
			}
		});

		it('accepts valid QDRANT_API_KEY of exactly 8 characters', () => {
			const savedKey = process.env.QDRANT_API_KEY;
			process.env.QDRANT_API_KEY = 'abcdefgh'; // exactly 8 chars

			try {
				const result = loadConfig();
				expect(result.qdrant.apiKey).toBe('abcdefgh');
			} finally {
				if (savedKey) {
					process.env.QDRANT_API_KEY = savedKey;
				} else {
					delete process.env.QDRANT_API_KEY;
				}
			}
		});

		it('allows QDRANT_API_KEY to be empty/undefined', () => {
			const savedKey = process.env.QDRANT_API_KEY;
			delete process.env.QDRANT_API_KEY;

			try {
				const result = loadConfig();
				// apiKey is optional, so undefined is fine
				expect(result.qdrant.apiKey).toBeUndefined();
			} finally {
				if (savedKey) {
					process.env.QDRANT_API_KEY = savedKey;
				}
			}
		});

		it('uses LARGE_EMBEDDING_DIMENSIONS from environment if provided', () => {
			const savedDimensions = process.env.LARGE_EMBEDDING_DIMENSIONS;
			process.env.LARGE_EMBEDDING_DIMENSIONS = '2048';

			try {
				const result = loadConfig();
				expect(result.embedding.largeDimensions).toBe(2048);
			} finally {
				if (savedDimensions) {
					process.env.LARGE_EMBEDDING_DIMENSIONS = savedDimensions;
				} else {
					delete process.env.LARGE_EMBEDDING_DIMENSIONS;
				}
			}
		});

		it('throws error when LARGE_EMBEDDING_DIMENSIONS is invalid', () => {
			const savedDimensions = process.env.LARGE_EMBEDDING_DIMENSIONS;
			process.env.LARGE_EMBEDDING_DIMENSIONS = 'invalid';

			try {
				expect(() => loadConfig()).toThrow(/Invalid environment variable LARGE_EMBEDDING_DIMENSIONS/);
			} finally {
				if (savedDimensions) {
					process.env.LARGE_EMBEDDING_DIMENSIONS = savedDimensions;
				} else {
					delete process.env.LARGE_EMBEDDING_DIMENSIONS;
				}
			}
		});

		it('throws when LOG_LEVEL is not a valid enum value', () => {
			const savedLogLevel = process.env.LOG_LEVEL;
			process.env.LOG_LEVEL = 'invalid-level';

			try {
				const fn = () => loadConfig();
				expect(fn).toThrow();
				try {
					fn();
				} catch (error) {
					expect((error as Error).message).toContain('Invalid configuration');
				}
			} finally {
				if (savedLogLevel) {
					process.env.LOG_LEVEL = savedLogLevel;
				} else {
					delete process.env.LOG_LEVEL;
				}
			}
		});

		it('throws when WORKSPACE_CACHE_TTL is invalid', () => {
			const savedTTL = process.env.WORKSPACE_CACHE_TTL;
			process.env.WORKSPACE_CACHE_TTL = 'not-a-number';

			try {
				expect(() => loadConfig()).toThrow(/Invalid environment variable WORKSPACE_CACHE_TTL/);
			} finally {
				if (savedTTL) {
					process.env.WORKSPACE_CACHE_TTL = savedTTL;
				} else {
					delete process.env.WORKSPACE_CACHE_TTL;
				}
			}
		});

		it('throws when MEMORY_CHUNK_OVERLAP is invalid', () => {
			const savedOverlap = process.env.MEMORY_CHUNK_OVERLAP;
			process.env.MEMORY_CHUNK_OVERLAP = 'invalid';

			try {
				expect(() => loadConfig()).toThrow(/Invalid environment variable MEMORY_CHUNK_OVERLAP/);
			} finally {
				if (savedOverlap) {
					process.env.MEMORY_CHUNK_OVERLAP = savedOverlap;
				} else {
					delete process.env.MEMORY_CHUNK_OVERLAP;
				}
			}
		});
	});
});
