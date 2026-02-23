/**
 * Configuration management
 *
 * Loads and validates environment variables from .env file
 */

import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenv.config();

/** Default Qdrant request timeout in milliseconds. */
const DEFAULT_QDRANT_TIMEOUT_MS = 30000;
/** Default memory chunk size in characters. */
const DEFAULT_CHUNK_SIZE = 1000;
/** Default overlap between adjacent chunks in characters. */
const DEFAULT_CHUNK_OVERLAP = 200;
/** Default workspace cache TTL in milliseconds. */
const DEFAULT_WORKSPACE_CACHE_TTL_MS = 60000;
/** OpenAI text-embedding-3-small output dimensions. */
const OPENAI_SMALL_EMBEDDING_DIMENSIONS = 1536;
/** Default output dimensions for the local HuggingFace embedding model. */
const DEFAULT_LOCAL_EMBEDDING_DIMENSIONS = 384;
/** Default output dimensions for OpenAI text-embedding-3-large. */
const DEFAULT_OPENAI_LARGE_EMBEDDING_DIMENSIONS = 3072;
/** Minimum length for QDRANT_API_KEY to guard against accidental single-char values. */
const MIN_QDRANT_API_KEY_LENGTH = 8;

/**
 * Parse an integer from an environment variable string.
 * Throws a descriptive error if the value is not a valid integer.
 *
 * @param raw   - Raw string from the environment (or undefined).
 * @param fallback - Default value used when `raw` is undefined.
 * @param name  - Variable name used in error messages.
 */
function parseIntEnv(raw: string | undefined, fallback: number, name: string): number {
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
	// OpenAI API (optional — only required when provider is 'openai')
	openai: z.object({
		apiKey: z.string().optional(),
	}),

	// Embedding provider
	embedding: z.object({
		// 'openai' uses OpenAI API; 'local' uses @huggingface/transformers (free, no API key)
		provider: z.enum(['openai', 'local']),
		// HuggingFace model id used when provider is 'local'
		localModel: z.string(),
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
		logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
	}),

	// Memory configuration
	memory: z.object({
		chunkSize: z.number().default(DEFAULT_CHUNK_SIZE),
		chunkOverlap: z.number().default(DEFAULT_CHUNK_OVERLAP),
	}),

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
 * 1. `dotenv.config()` populates `process.env` from `.env` if present.
 * 2. Each variable is read, defaulted, and coerced.
 * 3. The assembled object is parsed by Zod — any schema violation throws.
 *
 * @returns Validated, immutable configuration object.
 * @throws If `EMBEDDING_PROVIDER=openai` is set without `OPENAI_API_KEY`,
 *   or if any value fails Zod validation.
 */
function loadConfig(): Config {
	// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
	const apiKey = process.env.OPENAI_API_KEY || undefined; // || intentional: coerce empty string to undefined

	// Determine embedding provider:
	//   - explicit EMBEDDING_PROVIDER env var overrides everything
	//   - otherwise: 'openai' if OPENAI_API_KEY is set, 'local' if not
	const explicitProvider = process.env.EMBEDDING_PROVIDER as 'openai' | 'local' | undefined;
	const provider: 'openai' | 'local' = explicitProvider ?? (apiKey ? 'openai' : 'local');

	// Fail early with a clear message if openai provider is requested but the key is absent
	if (provider === 'openai' && !apiKey) {
		throw new Error(
			'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai. ' +
      'Either set OPENAI_API_KEY or remove EMBEDDING_PROVIDER to use local embeddings.',
		);
	}

	const localModel = process.env.LOCAL_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
	const localDimensions = parseIntEnv(process.env.LOCAL_EMBEDDING_DIMENSIONS, DEFAULT_LOCAL_EMBEDDING_DIMENSIONS, 'LOCAL_EMBEDDING_DIMENSIONS');
	const openaiLargeDimensions = parseIntEnv(process.env.LARGE_EMBEDDING_DIMENSIONS, DEFAULT_OPENAI_LARGE_EMBEDDING_DIMENSIONS, 'LARGE_EMBEDDING_DIMENSIONS');

	// Derive vector dimensions from the chosen provider
	const smallDimensions = provider === 'openai' ? OPENAI_SMALL_EMBEDDING_DIMENSIONS : localDimensions;
	const largeDimensions = provider === 'openai' ? openaiLargeDimensions : localDimensions;

	const rawConfig = {
		openai: {
			apiKey,
		},
		embedding: {
			provider,
			localModel,
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
			logLevel: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
		},
		memory: {
			chunkSize: parseIntEnv(process.env.MEMORY_CHUNK_SIZE, DEFAULT_CHUNK_SIZE, 'MEMORY_CHUNK_SIZE'),
			chunkOverlap: parseIntEnv(process.env.MEMORY_CHUNK_OVERLAP, DEFAULT_CHUNK_OVERLAP, 'MEMORY_CHUNK_OVERLAP'),
		},
		workspace: {
			autoDetect: process.env.WORKSPACE_AUTO_DETECT !== 'false',
			default: process.env.WORKSPACE_DEFAULT ?? null,
			cacheTTL: parseIntEnv(process.env.WORKSPACE_CACHE_TTL, DEFAULT_WORKSPACE_CACHE_TTL_MS, 'WORKSPACE_CACHE_TTL'),
		},
		rules: {
			copyClaudeRules: process.env.COPY_CLAUDE_RULES !== 'false',
		},
	};

	try {
		return ConfigSchema.parse(rawConfig);
	} catch (error) {
		if (error instanceof z.ZodError) {
			console.error('Configuration validation failed:');
			error.errors.forEach(err => {
				console.error(`  - ${err.path.join('.')}: ${err.message}`);
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
