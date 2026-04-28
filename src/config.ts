/**
 * Configuration management
 *
 * Loads and validates environment variables from .env file
 */

import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env if present.
// quiet: true suppresses the "missing file" warning in environments where
// variables are injected directly (CI, Docker, production).
dotenv.config({ quiet: true });

/** Default Qdrant request timeout in milliseconds. */
const DEFAULT_QDRANT_TIMEOUT_MS = 30000;
/** Default memory chunk size in characters. */
const DEFAULT_CHUNK_SIZE = 1000;
/** Default overlap between adjacent chunks in characters. */
const DEFAULT_CHUNK_OVERLAP = 200;
/** Default workspace cache TTL in milliseconds. */
const DEFAULT_WORKSPACE_CACHE_TTL_MS = 60000;
/**
 * Default output dimensions for OpenAI `text-embedding-3-small`.
 * Overridden at runtime by the `SMALL_EMBEDDING_DIMENSIONS` environment variable.
 */
const DEFAULT_SMALL_EMBEDDING_DIMENSIONS = 1536;
/** Default output dimensions for OpenAI text-embedding-3-large. */
const DEFAULT_OPENAI_LARGE_EMBEDDING_DIMENSIONS = 3072;
/** Minimum length for QDRANT_API_KEY to guard against accidental single-char values. */
const MIN_QDRANT_API_KEY_LENGTH = 8;

/**
 * Parse a boolean from an environment variable string.
 * Treats 'false', '0', 'no', and 'off' (case-insensitive) as `false`;
 * any other non-empty string as `true`; and `undefined` as `fallback`.
 *
 * @param raw      - Raw string from the environment (or undefined).
 * @param fallback - Default value used when `raw` is undefined.
 * @returns The parsed boolean value.
 * @example
 * parseBoolEnv('true', false) // true
 * parseBoolEnv('false', true) // false
 * parseBoolEnv(undefined, true) // true
 */
export function parseBoolEnv(raw: string | undefined, fallback: boolean): boolean {
	if (raw === undefined) return fallback;
	if (raw.trim().length === 0) return fallback;
	const lower = raw.toLowerCase();
	return lower !== 'false' && lower !== '0' && lower !== 'no' && lower !== 'off';
}

/**
 * Parse an integer from an environment variable string.
 * Throws a descriptive error if the value is not a valid integer.
 *
 * @param raw      - Raw string from the environment (or undefined).
 * @param fallback - Default value used when `raw` is undefined.
 * @param name     - Variable name used in error messages.
 * @returns The parsed integer value or the fallback.
 * @throws {Error} If the value is not a valid integer.
 * @example
 * parseIntEnv('123', 10, 'MY_VAR') // 123
 * parseIntEnv(undefined, 10, 'MY_VAR') // 10
 * parseIntEnv('abc', 10, 'MY_VAR') // throws Error
 */
export function parseIntEnv(raw: string | undefined, fallback: number, name: string): number {
	if (raw === undefined) return fallback;
	const parsed = parseInt(raw, 10);
	if (isNaN(parsed) || !isFinite(parsed)) {
		throw new Error(
			`Invalid environment variable ${name}="${raw}": expected an integer, got "${raw}". ` +
			`Using the default (${fallback}) requires unsetting the variable.`,
		);
	}
	return parsed;
}

/**
 * Zod schema that describes every supported configuration value.
 *
 * Environment variables are parsed in {@link loadConfig} and coerced into
 * the correct types here.  A `ZodError` is thrown at startup if any required
 * field is missing or invalid.
 */
const ConfigSchema = z.object({
	// OpenAI API
	openai: z.object({
		apiKey: z.string().min(1, 'OPENAI_API_KEY is required — set it in .env or the environment'),
	}),

	// Embedding provider
	embedding: z.object({
		// Vector dimensions for the primary (small/dense) embedding
		smallDimensions: z.number().int().positive(),
		// Vector dimensions for the secondary (large) embedding
		largeDimensions: z.number().int().positive(),
	}),

	// Qdrant Vector Database
	qdrant: z.object({
		url: z.string().url().default('http://localhost:6333'),
		// When set, must be at least 8 characters to guard against accidental single-char values
		apiKey: z.string().min(MIN_QDRANT_API_KEY_LENGTH, 'QDRANT_API_KEY must be at least 8 characters when set').optional(),
		collection: z.string().default('mcp-memory'),
		timeout: z.number().default(DEFAULT_QDRANT_TIMEOUT_MS),
	}),

	// Server configuration
	server: z.object({
		logLevel: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
	}),

	// Memory configuration
	memory: z.object({
		chunkSize: z.number().default(DEFAULT_CHUNK_SIZE),
		chunkOverlap: z.number().default(DEFAULT_CHUNK_OVERLAP),
	}).refine(
		({ chunkSize, chunkOverlap }) => chunkOverlap < chunkSize,
		{ message: 'MEMORY_CHUNK_OVERLAP must be strictly less than MEMORY_CHUNK_SIZE to avoid an infinite chunking loop' },
	),

	// Workspace configuration
	workspace: z.object({
		autoDetect: z.boolean().default(true),
		default: z.string().nullable().default(null),
		cacheTTL: z.number().default(DEFAULT_WORKSPACE_CACHE_TTL_MS), // 60 seconds
	}),

	// Rules configuration
	rules: z.object({
		copyClaudeRules: z.boolean().default(true),
	}),
});

/**
 * Fully-resolved, type-safe application configuration.
 * Inferred from {@link ConfigSchema} — see that schema for field documentation.
 */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Load configuration from environment variables and validate against {@link ConfigSchema}.
 *
 * Call order at startup:
 * 1. `dotenv.config({ quiet: true })` populates `process.env` from `.env` if present.
 * 2. Each variable is read, defaulted, and coerced.
 * 3. The assembled object is parsed by Zod — any schema violation throws.
 *
 * @returns Validated, immutable configuration object.
 * @throws {Error} If `OPENAI_API_KEY` is not set, or if any value fails Zod validation.
 * @example
 * // In production, set OPENAI_API_KEY and QDRANT_URL in .env or environment
 * const config = loadConfig();
 */
export function loadConfig(): Config {
	// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
	const apiKey = process.env.OPENAI_API_KEY || undefined; // || intentional: coerce empty string to undefined

	const smallDimensions = parseIntEnv(process.env.SMALL_EMBEDDING_DIMENSIONS, DEFAULT_SMALL_EMBEDDING_DIMENSIONS, 'SMALL_EMBEDDING_DIMENSIONS');
	const largeDimensions = parseIntEnv(process.env.LARGE_EMBEDDING_DIMENSIONS, DEFAULT_OPENAI_LARGE_EMBEDDING_DIMENSIONS, 'LARGE_EMBEDDING_DIMENSIONS');

	const rawConfig = {
		openai: {
			apiKey,
		},
		embedding: {
			smallDimensions,
			largeDimensions,
		},
		qdrant: {
			url: process.env.QDRANT_URL ?? 'http://localhost:6333',
			// Coerce empty string to undefined so Zod treats it as absent
			// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
			apiKey: process.env.QDRANT_API_KEY || undefined,
			collection: process.env.QDRANT_COLLECTION ?? 'mcp-memory',
			timeout: parseIntEnv(process.env.QDRANT_TIMEOUT, DEFAULT_QDRANT_TIMEOUT_MS, 'QDRANT_TIMEOUT'),
		},
		server: {
			logLevel: process.env.LOG_LEVEL ?? 'info',
		},
		memory: {
			chunkSize: parseIntEnv(process.env.MEMORY_CHUNK_SIZE, DEFAULT_CHUNK_SIZE, 'MEMORY_CHUNK_SIZE'),
			chunkOverlap: parseIntEnv(process.env.MEMORY_CHUNK_OVERLAP, DEFAULT_CHUNK_OVERLAP, 'MEMORY_CHUNK_OVERLAP'),
		},
		workspace: {
			autoDetect: parseBoolEnv(process.env.WORKSPACE_AUTO_DETECT, true),
			default: process.env.WORKSPACE_DEFAULT ?? null,
			cacheTTL: parseIntEnv(process.env.WORKSPACE_CACHE_TTL, DEFAULT_WORKSPACE_CACHE_TTL_MS, 'WORKSPACE_CACHE_TTL'),
		},
		rules: {
			copyClaudeRules: parseBoolEnv(process.env.COPY_CLAUDE_RULES, true),
		},
	};

	try {
		return ConfigSchema.parse(rawConfig);
	} catch (error) {
		if (error instanceof z.ZodError) {
			// Chicken-and-egg: logger depends on config being loaded, so we must use
			// console.error here even though we use structured logging elsewhere.
			console.error('Configuration validation failed:');
			error.issues.forEach((issue) => {
				console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
			});
		}
		throw new Error('Invalid configuration', { cause: error });
	}
}

/**
 * Application-wide configuration singleton.
 * Loaded and validated once at module initialisation time.
 * Import this object wherever configuration values are needed.
 */
export const config = loadConfig();
