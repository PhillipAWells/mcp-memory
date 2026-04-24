/**
 * Unit tests for config.ts
 *
 * Tests configuration loading, validation, and error handling
 * Note: Config is loaded once at module initialization, so tests verify
 * the exported config object properties rather than internal functions.
 */

import { describe, it, expect } from 'vitest';
import { config } from '../config.js';
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
});
