/**
 * Zod validation schemas for all memory tool inputs.
 *
 * Each schema validates the raw `args` object received by an MCP tool handler
 * before any business logic runs.  The companion `export type` aliases are
 * inferred directly from the schemas so the types and validation rules can
 * never drift apart.
 *
 * {@link memorySchemas} converts every schema to JSON Schema format for MCP
 * tool registration.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const TAG_MAX_LENGTH = 50;
const TAGS_MAX_COUNT = 20;
const CONTENT_MAX_LENGTH = 100_000;
const QUERY_MAX_LENGTH = 10_000;
const LIST_LIMIT_MAX = 1_000;
const RESULT_LIMIT_MAX = 100;
const HNSW_EF_MIN = 64;
const HNSW_EF_MAX = 512;
const DEFAULT_RESULT_LIMIT = 10;
const BATCH_DELETE_MAX = 100;

/**
 * Zod enum for the three supported memory classification types.
 * - `episodic`   — session-specific experiences (auto-expires in 90 days)
 * - `short-term` — volatile working context (auto-expires in 7 days)
 * - `long-term`  — persistent facts, concepts, and workflows (no expiry)
 */
const MemoryTypeSchema = z.enum([
	'episodic',
	'short-term',
	'long-term',
]);

/**
 * Base metadata schema accepted by `memory-store` and `memory-update`.
 *
 * `.passthrough()` allows callers to include arbitrary custom fields beyond
 * the defined properties, which are forwarded verbatim to Qdrant.
 */
const MetadataInputSchema = z
	.object({
		/** Classification controlling retention policy and search behaviour. */
		memory_type: MemoryTypeSchema.optional(),
		/** Workspace slug for multi-project isolation (`[a-zA-Z0-9_-]+`). */
		workspace: z.string().regex(/^[a-zA-Z0-9_-]+$/).nullable().optional(),
		/** Confidence score in [0, 1] indicating memory reliability. */
		confidence: z.number().min(0.0).max(1.0).optional(),
		/** ISO 8601 datetime after which the memory is considered expired. */
		expires_at: z.string().datetime().nullable().optional(),
		/** Up to 20 searchable tags; each tag is 1–50 characters. */
		tags: z.array(z.string().min(1).max(TAG_MAX_LENGTH)).max(TAGS_MAX_COUNT).optional(),
	})
	.passthrough(); // Allow additional custom fields

/**
 * Input schema for the `memory-store` tool.
 *
 * Validates content length (1–100 000 chars), optional metadata, and the
 * `auto_chunk` flag that triggers automatic splitting of long content.
 */
export const MemoryStoreInputSchema = z.object({
	/** The text content to embed and store (1–100 000 characters). */
	content: z.string().min(1).max(CONTENT_MAX_LENGTH),
	/** Optional classification and organisational metadata. */
	metadata: MetadataInputSchema.optional(),
	/**
   * When `true` (default), content longer than 1 000 characters is split into
   * overlapping chunks, each stored as a separate point that shares a
   * `chunk_group_id`.
   */
	auto_chunk: z.boolean().optional().default(true),
});

/** Type-safe input for the `memory-store` tool, inferred from {@link MemoryStoreInputSchema}. */
export type MemoryStoreInput = z.infer<typeof MemoryStoreInputSchema>;

/**
 * Input schema for the `memory-query` tool.
 *
 * Validates the natural-language query, optional filters, pagination, and
 * hybrid-search parameters.
 */
export const MemoryQueryInputSchema = z.object({
	/** Natural-language search query (1–10 000 characters). */
	query: z.string().min(1).max(QUERY_MAX_LENGTH),
	/** Optional filter to narrow results by workspace, type, confidence, or tags. */
	filter: z
		.object({
			workspace: z.string().regex(/^[a-zA-Z0-9_-]+$/).nullable().optional(),
			memory_type: MemoryTypeSchema.optional(),
			min_confidence: z.number().min(0.0).max(1.0).optional(),
			tags: z.array(z.string().min(1).max(TAG_MAX_LENGTH)).max(TAGS_MAX_COUNT).optional(),
		})
		.optional(),
	/** Maximum number of results to return (1–100, default 10). */
	limit: z.number().int().min(1).max(RESULT_LIMIT_MAX).optional().default(DEFAULT_RESULT_LIMIT),
	/** Number of results to skip for pagination (default 0). */
	offset: z.number().int().min(0).optional().default(0),
	/** Minimum cosine similarity score in [0, 1] required for a result to be included. */
	score_threshold: z.number().min(0.0).max(1.0).optional(),
	/**
   * HNSW `ef` parameter (64–512) controlling search thoroughness.
   * Higher values improve recall at the cost of latency.
   */
	hnsw_ef: z.number().int().min(HNSW_EF_MIN).max(HNSW_EF_MAX).optional(),
	/**
   * When `true`, combine vector similarity search with full-text index search
   * using Reciprocal Rank Fusion (default `false`).
   */
	use_hybrid_search: z.boolean().optional().default(false),
	/**
   * Weight between dense vector (1.0) and full-text (0.0) scoring in hybrid
   * mode (default 0.5).  Ignored when `use_hybrid_search` is `false`.
   */
	hybrid_alpha: z.number().min(0.0).max(1.0).optional(),
});

/** Type-safe input for the `memory-query` tool, inferred from {@link MemoryQueryInputSchema}. */
export type MemoryQueryInput = z.infer<typeof MemoryQueryInputSchema>;

/**
 * Input schema for the `memory-list` tool.
 *
 * Supports filtering, pagination, and server-side / in-memory sorting.
 * Note: sorting by fields other than `created_at` loads all matching records
 * into memory (capped at 10 000) before paginating — use filters to limit
 * result sets when sorting by `access_count` or `confidence`.
 */
export const MemoryListInputSchema = z.object({
	/** Optional filter to narrow the listed memories. */
	filter: z
		.object({
			workspace: z.string().regex(/^[a-zA-Z0-9_-]+$/).nullable().optional(),
			memory_type: MemoryTypeSchema.optional(),
			min_confidence: z.number().min(0.0).max(1.0).optional(),
			tags: z.array(z.string().min(1).max(TAG_MAX_LENGTH)).max(TAGS_MAX_COUNT).optional(),
		})
		.optional(),
	/** Maximum number of memories to return per page (1–1 000, default 100). */
	limit: z.number().int().min(1).max(LIST_LIMIT_MAX).optional().default(RESULT_LIMIT_MAX),
	/** Number of memories to skip for pagination (default 0). */
	offset: z.number().int().min(0).optional().default(0),
	/** Field to sort results by (default `'created_at'`). */
	sort_by: z
		.enum(['created_at', 'updated_at', 'access_count', 'confidence'])
		.optional()
		.default('created_at'),
	/** Sort direction (default `'desc'` — newest or highest first). */
	sort_order: z.enum(['asc', 'desc']).optional().default('desc'),
});

/** Type-safe input for the `memory-list` tool, inferred from {@link MemoryListInputSchema}. */
export type MemoryListInput = z.infer<typeof MemoryListInputSchema>;

/**
 * Input schema for the `memory-get` tool.
 * Validates that the caller supplies a well-formed UUID.
 */
export const MemoryGetInputSchema = z.object({
	/** UUID of the memory to retrieve. */
	id: z.string().uuid(),
});

/** Type-safe input for the `memory-get` tool, inferred from {@link MemoryGetInputSchema}. */
export type MemoryGetInput = z.infer<typeof MemoryGetInputSchema>;

/**
 * Input schema for the `memory-update` tool.
 *
 * At least one of `content` or `metadata` must be provided (enforced by
 * the handler, not the schema).  Setting `reindex: true` regenerates
 * embeddings for the new content and overwrites the point atomically.
 */
export const MemoryUpdateInputSchema = z.object({
	/** UUID of the memory to update. */
	id: z.string().uuid(),
	/** Replacement content (1–100 000 characters). Required when `reindex` is `true`. */
	content: z.string().min(1).max(CONTENT_MAX_LENGTH).optional(),
	/** Metadata fields to merge into the existing payload. */
	metadata: MetadataInputSchema.optional(),
	/**
   * When `true`, regenerate embeddings from `content` and overwrite the
   * existing Qdrant point (upsert-first, no delete risk).  Default `false`.
   */
	reindex: z.boolean().optional().default(false),
});

/** Type-safe input for the `memory-update` tool, inferred from {@link MemoryUpdateInputSchema}. */
export type MemoryUpdateInput = z.infer<typeof MemoryUpdateInputSchema>;

/**
 * Input schema for the `memory-delete` tool.
 */
export const MemoryDeleteInputSchema = z.object({
	/** UUID of the memory to delete. */
	id: z.string().uuid(),
});

/** Type-safe input for the `memory-delete` tool, inferred from {@link MemoryDeleteInputSchema}. */
export type MemoryDeleteInput = z.infer<typeof MemoryDeleteInputSchema>;

/**
 * Input schema for the `memory-batch-delete` tool.
 * Accepts 1–100 UUIDs per call.
 */
export const MemoryBatchDeleteInputSchema = z.object({
	/** Array of UUIDs to delete (1–100 items). */
	ids: z.array(z.string().uuid()).min(1).max(BATCH_DELETE_MAX),
});

/** Type-safe input for the `memory-batch-delete` tool, inferred from {@link MemoryBatchDeleteInputSchema}. */
export type MemoryBatchDeleteInput = z.infer<
  typeof MemoryBatchDeleteInputSchema
>;

/**
 * Input schema for the `memory-status` tool.
 */
export const MemoryStatusInputSchema = z.object({
	/**
   * When provided, include a per-workspace point count in the response.
   * Use `null` to query memories with no workspace.
   */
	workspace: z.string().regex(/^[a-zA-Z0-9_-]+$/).nullable().optional(),
	/** When `true` (default), include embedding cache and cost statistics. */
	include_embedding_stats: z.boolean().optional().default(true),
});

/** Type-safe input for the `memory-status` tool, inferred from {@link MemoryStatusInputSchema}. */
export type MemoryStatusInput = z.infer<typeof MemoryStatusInputSchema>;

/**
 * Input schema for the `memory-count` tool.
 */
export const MemoryCountInputSchema = z.object({
	/** Optional filter to count only matching memories. */
	filter: z
		.object({
			workspace: z.string().regex(/^[a-zA-Z0-9_-]+$/).nullable().optional(),
			memory_type: MemoryTypeSchema.optional(),
			min_confidence: z.number().min(0.0).max(1.0).optional(),
			tags: z.array(z.string().min(1).max(TAG_MAX_LENGTH)).max(TAGS_MAX_COUNT).optional(),
		})
		.optional(),
});

/** Type-safe input for the `memory-count` tool, inferred from {@link MemoryCountInputSchema}. */
export type MemoryCountInput = z.infer<typeof MemoryCountInputSchema>;

/**
 * JSON Schema representations of all memory tool input schemas, keyed by tool name.
 *
 * Generated from the Zod schemas via `zod-to-json-schema` and passed directly
 * to the MCP server during tool registration so the protocol layer can validate
 * incoming requests before handlers are invoked.
 */
export const memorySchemas = {
	'memory-store': zodToJsonSchema(MemoryStoreInputSchema),
	'memory-query': zodToJsonSchema(MemoryQueryInputSchema),
	'memory-list': zodToJsonSchema(MemoryListInputSchema),
	'memory-get': zodToJsonSchema(MemoryGetInputSchema),
	'memory-update': zodToJsonSchema(MemoryUpdateInputSchema),
	'memory-delete': zodToJsonSchema(MemoryDeleteInputSchema),
	'memory-batch-delete': zodToJsonSchema(MemoryBatchDeleteInputSchema),
	'memory-status': zodToJsonSchema(MemoryStatusInputSchema),
	'memory-count': zodToJsonSchema(MemoryCountInputSchema),
};
