/**
 * Qdrant Vector Database Client
 *
 * Implements best practices for collection management, indexing, and search
 * Based on official Qdrant documentation and performance guidelines
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { MemoryError, extractErrorMessage } from '../utils/errors.js';
import type {
	QdrantPayload,
	SearchFilters,
	SearchResult,
} from '../types/index.js';

/** Default confidence score for new points. */
const DEFAULT_CONFIDENCE = 0.7;
/** Default search result limit. */
const DEFAULT_SEARCH_LIMIT = 10;
/** Default HNSW ef search parameter. */
const DEFAULT_HNSW_EF = 128;
/** RRF rank fusion constant. */
const RRF_K = 60;
/** Multiplier for RRF pre-fetch limit. */
const RRF_FETCH_MULTIPLIER = 3;
/** Batch size for upsert operations. */
const UPSERT_BATCH_SIZE = 500;
/** HNSW graph connectivity parameter. */
const HNSW_M = 16;
/** HNSW ef_construct parameter. */
const HNSW_EF_CONSTRUCT = 200;
/** HNSW full scan threshold. */
const HNSW_FULL_SCAN_THRESHOLD = 10_000;
/** Scalar quantization quantile. */
const QUANTIZATION_QUANTILE = 0.99;
/** Max optimizer segment size. */
const OPTIMIZER_MAX_SEGMENT_SIZE = 200_000;
/** Optimizer memmap threshold. */
const OPTIMIZER_MEMMAP_THRESHOLD = 50_000;
/** Optimizer indexing threshold. */
const OPTIMIZER_INDEXING_THRESHOLD = 20_000;
/** Optimizer flush interval in seconds. */
const OPTIMIZER_FLUSH_INTERVAL_SEC = 5;
/** Max token length for text index. */
const TEXT_INDEX_MAX_TOKEN_LEN = 20;
/** Default list page size. */
const DEFAULT_LIST_LIMIT = 100;
/** Percentage multiplier for success rate calculation. */
const PERCENT = 100;
/** Minimum time interval (ms) between access tracking warning logs. */
const ACCESS_TRACKING_WARNING_INTERVAL_MS = 10_000;
/** Default HTTPS port. */
const HTTPS_DEFAULT_PORT = 443;
/** Default hybrid search alpha weighting (0.5 = equal weighting between vector and text). */
const DEFAULT_HYBRID_ALPHA = 0.5;

/**
 * Type guard to check if a value is a valid QdrantPayload.
 *
 * Validates required fields: `content` (string), `created_at` (string), `updated_at` (string).
 * Returns true only if the payload matches the expected structure.
 *
 * @param p - The value to check.
 * @returns boolean - True if p is a valid QdrantPayload, false otherwise.
 * @example
 * ```typescript
 * const payload = { content: 'hello', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
 * if (isQdrantPayload(payload)) {
 *   // payload is now narrowed to QdrantPayload type
 * }
 * ```
 */
function isQdrantPayload(p: unknown): p is QdrantPayload {
	return (
		typeof p === 'object' &&
		p !== null &&
		'content' in p &&
		typeof (p as Record<string, unknown>).content === 'string' &&
		'created_at' in p &&
		typeof (p as Record<string, unknown>).created_at === 'string' &&
		'updated_at' in p &&
		typeof (p as Record<string, unknown>).updated_at === 'string'
	);
}

/**
 * Type guard to check if search parameters represent a hybrid search operation.
 *
 * Hybrid search requires both `useHybridSearch` to be true and `query` to be a non-empty string.
 * Used to narrow `SearchParams` to `HybridSearchParams` before calling `hybridSearchWithRRF()`.
 *
 * @param p - The search parameters to check.
 * @returns boolean - True if p is configured for hybrid search, false otherwise.
 * @example
 * ```typescript
 * const params: SearchParams = { vector: [...], query: 'text', useHybridSearch: true };
 * if (isHybridSearchParams(params)) {
 *   // params is now narrowed to HybridSearchParams
 *   await service.hybridSearchWithRRF(params, filter);
 * }
 * ```
 */
function isHybridSearchParams(p: SearchParams): p is HybridSearchParams {
	return typeof p.query === 'string' && p.query.length > 0 && p.useHybridSearch === true;
}

/**
 * Normalizes optimizer status from various Qdrant API response shapes into a string.
 *
 * The optimizer_status can be a string, an error object, or an ok object.
 * This function safely extracts a normalized string representation.
 *
 * @param status - The raw optimizer_status value from Qdrant API response.
 * @returns A normalized string representation of the optimizer status.
 * @example
 * ```typescript
 * const normalized = normalizeOptimizerStatus(info.optimizer_status);
 * console.log(normalized); // 'ok' or 'error: ...' or 'running' etc.
 * ```
 */
function normalizeOptimizerStatus(status: unknown): string {
	if (typeof status === 'string') {
		return status;
	}
	if (typeof status === 'object' && status !== null) {
		const obj = status as Record<string, unknown>;
		if ('error' in obj && typeof obj.error === 'string') {
			return `error: ${obj.error}`;
		}
		if ('ok' in obj) {
			return 'ok';
		}
	}
	return 'unknown';
}

/**
 * Represents a single point in the Qdrant vector database.
 * @internal
 */
interface QdrantPoint {
	id: string;
	vector: { dense: number[]; dense_large?: number[] };
	payload: QdrantPayload;
}

/**
 * Result of a batch upsert operation to Qdrant.
 *
 * @property successfulIds - Array of point IDs that were successfully upserted.
 * @property failedPoints - Array of points that failed to upsert, with error details.
 * @property totalProcessed - Total number of points processed (successful + failed).
 */
interface BatchUpsertResult {
	successfulIds: string[];
	failedPoints: Array<{ index: number; id: string; error: string }>;
	totalProcessed: number;
}

/**
 * Search parameters
 */
interface SearchParams {
	vector: number[];
	vectorLarge?: number[]; // Optional large embedding for dual embedding search
	filter?: SearchFilters;
	limit?: number;
	offset?: number;
	scoreThreshold?: number;
	withPayload?: boolean;
	withVector?: boolean;
	hnsw_ef?: number;
	// Hybrid search options
	query?: string; // Text query for hybrid search
	useHybridSearch?: boolean; // Enable hybrid search with RRF
	hybridAlpha?: number; // Weight between dense (1.0) and keyword full-text (0.0) search, default 0.5
	// Dual embedding options
}

/**
 * Internal interface for hybrid search parameters, ensuring query is required.
 */
interface HybridSearchParams extends SearchParams {
	query: string; // Required for hybrid search
}

/**
 * Collection statistics from Qdrant.
 *
 * @property indexed_vectors_count - Number of vectors that have been indexed in HNSW.
 * @property points_count - Total number of points in the collection.
 * @property segments_count - Number of collection segments.
 * @property status - Collection status (e.g., 'green', 'yellow', 'red').
 * @property optimizer_status - Status of the background optimizer.
 * @property config - Collection configuration object (structure varies by Qdrant version).
 * @property access_tracking_failures - Cumulative count of access-tracking update failures since service start.
 */
interface CollectionStats {
	indexed_vectors_count: number;
	points_count: number;
	segments_count: number;
	status: string;
	optimizer_status: string;
	config: unknown;
	access_tracking_failures: number;
}

/**
 * Qdrant Client Service
 *
 * Manages vector database operations with optimized configuration.
 * Note: The underlying QdrantClient does not support explicit connection closing;
 * connections are automatically managed by the HTTP client.
 *
 * @example
 * ```typescript
 * const service = new QdrantService();
 * await service.initialize(); // Create/validate collection
 * const results = await service.search([0.1, 0.2, 0.3], { limit: 5 });
 * await service.store({ id: 'uuid', content: 'text', embedding: [...] });
 * await service.delete('uuid');
 * ```
 */
export class QdrantService {
	private readonly client: QdrantClient;
	private readonly collectionName: string;
	// Mutable: one-time initialization guard, reset to undefined only during reconnection
	private initPromise: Promise<void> | undefined;
	// Mutable: incremented on each failed access tracking operation
	private accessTrackingFailureCount: number = 0;
	// Mutable: updated on each access tracking warning log for rate-limiting
	private lastTrackingWarningTime: number = 0;

	constructor() {
		this.collectionName = config.qdrant.collection;

		// @qdrant/js-client-rest defaults to port 6333 regardless of the URL scheme.
		// For HTTPS URLs without an explicit port we must pass port: 443 so the
		// client connects on the standard TLS port instead.
		const parsedUrl = new URL(config.qdrant.url);
		const explicitPort = parsedUrl.port ? parseInt(parsedUrl.port, 10) : undefined;
		const httpsDefaultPort = parsedUrl.protocol === 'https:' ? HTTPS_DEFAULT_PORT : undefined;
		const port = explicitPort ?? httpsDefaultPort;

		// Initialize Qdrant client
		this.client = new QdrantClient({
			url: config.qdrant.url,
			...(port !== undefined && { port }),
			apiKey: config.qdrant.apiKey,
			timeout: config.qdrant.timeout,
		});

		logger.info(`Qdrant client initialized: ${config.qdrant.url}`);
	}

	/**
	 * Initializes the Qdrant collection with optimized configuration.
	 *
	 * Creates the collection if it doesn't exist, validates schema for existing collections, and creates payload indexes. Idempotent: subsequent calls are no-ops.
	 *
	 * @returns Resolves when initialization completes successfully.
	 * @throws {Error} If collection validation fails or index creation fails.
	 * @example
	 * ```typescript
	 * await qdrantService.initialize();
	 * ```
	 */
	public async initialize(): Promise<void> {
		if (this.initPromise) {
			await this.initPromise;
			return;
		}
		this.initPromise = (async () => {
			try {
				// Check if collection exists
				const collections = await this.client.getCollections();
				const exists = collections.collections.some(
					(c) => c.name === this.collectionName,
				);

				if (!exists) {
					logger.info(`Creating collection: ${this.collectionName}`);
					await this.createCollection();
				} else {
					logger.info(`Collection already exists: ${this.collectionName}`);
					await this.validateCollectionSchema();
				}

				// Create payload indexes
				await this.createPayloadIndexes();

				logger.info('Qdrant service initialized successfully');
			} catch (error) {
				logger.error('Failed to initialize Qdrant service:', error);
				this.initPromise = undefined;
				throw error;
			}
		})();
		await this.initPromise;
	}

	/**
   * Validate that an existing collection's vector schema is compatible.
   * Throws if the collection was created with different dimensions or is missing
   * named vectors (e.g. created before dual-embedding support was added).
   */
	private async validateCollectionSchema(): Promise<void> {
		const info = await this.client.getCollection(this.collectionName);
		const vectors = info.config?.params?.vectors;

		const expectedSmall = config.embedding.smallDimensions;
		const expectedLarge = config.embedding.largeDimensions;

		// Named-vector collections have an object keyed by vector name.
		// A flat {size, distance} object means the collection was created with a
		// single unnamed vector and is incompatible.
		if (!vectors || typeof vectors !== 'object' || 'size' in vectors) {
			throw new Error(
				`Collection "${this.collectionName}" uses a single unnamed vector and is incompatible ` +
        `with the current dual-embedding configuration (dense=${expectedSmall}d, dense_large=${expectedLarge}d). ` +
        'Delete the collection or set QDRANT_COLLECTION to a new name and restart.',
			);
		}

		const namedVectors = typeof vectors === 'object' && vectors !== null
			? (vectors as Record<string, { size?: number; distance?: string }>)
			: {};

		const { dense, dense_large: denseLarge } = namedVectors;

		const issues: string[] = [];

		if (!dense) {
			issues.push(`missing vector "dense" (expected size=${expectedSmall}, distance=Cosine)`);
		} else {
			if (dense.size !== expectedSmall) {
				issues.push(`"dense" size mismatch: found ${dense.size}, expected ${expectedSmall} — if you changed embedding provider/model, delete the collection or set QDRANT_COLLECTION to a new name`);
			}
			if (dense.distance !== 'Cosine') {
				issues.push(`"dense" distance mismatch: found ${dense.distance}, expected Cosine`);
			}
		}

		if (!denseLarge) {
			issues.push(`missing vector "dense_large" (expected size=${expectedLarge}, distance=Cosine)`);
		} else {
			if (denseLarge.size !== expectedLarge) {
				issues.push(`"dense_large" size mismatch: found ${denseLarge.size}, expected ${expectedLarge} — if you changed embedding provider/model, delete the collection or set QDRANT_COLLECTION to a new name`);
			}
			if (denseLarge.distance !== 'Cosine') {
				issues.push(`"dense_large" distance mismatch: found ${denseLarge.distance}, expected Cosine`);
			}
		}

		if (issues.length > 0) {
			throw new Error(
				`Collection "${this.collectionName}" is incompatible with the current embedding configuration:\n` +
        issues.map(i => `  - ${i}`).join('\n') + '\n' +
        'Delete the collection or set QDRANT_COLLECTION to a new name and restart.',
			);
		}

		logger.info(`Collection schema validated: dense=${expectedSmall}d, dense_large=${expectedLarge}d`);
	}

	/**
	 * Creates a Qdrant collection with dual named vectors (dense and dense_large) and the configured distance metric.
	 * Initializes HNSW indexes, quantization, and optimizer settings for production use.
	 */
	private async createCollection(): Promise<void> {
		await withRetry(() => this.client.createCollection(this.collectionName, {
			vectors: {
				dense: {
					size: config.embedding.smallDimensions,
					distance: 'Cosine' as const,
					on_disk: false,
					hnsw_config: { m: HNSW_M, ef_construct: HNSW_EF_CONSTRUCT, full_scan_threshold: HNSW_FULL_SCAN_THRESHOLD },
					quantization_config: {
						scalar: { type: 'int8' as const, quantile: QUANTIZATION_QUANTILE, always_ram: true },
					},
				},
				dense_large: {
					size: config.embedding.largeDimensions,
					distance: 'Cosine' as const,
					on_disk: false,
					hnsw_config: { m: HNSW_M, ef_construct: HNSW_EF_CONSTRUCT, full_scan_threshold: HNSW_FULL_SCAN_THRESHOLD },
					quantization_config: {
						scalar: { type: 'int8' as const, quantile: QUANTIZATION_QUANTILE, always_ram: true },
					},
				},
			},
			optimizers_config: {
				default_segment_number: 2,
				max_segment_size: OPTIMIZER_MAX_SEGMENT_SIZE,
				memmap_threshold: OPTIMIZER_MEMMAP_THRESHOLD,
				indexing_threshold: OPTIMIZER_INDEXING_THRESHOLD,
				flush_interval_sec: OPTIMIZER_FLUSH_INTERVAL_SEC,
			},
			replication_factor: 1,
			write_consistency_factor: 1,
			on_disk_payload: false,
		}));

		logger.info(`Collection created with dual embeddings and hybrid search: ${this.collectionName}`);
	}

	/**
	 * Creates payload field indexes for filtering (workspace, memory_type, tags, expires_at, chunk_group_id).
	 * Includes text index on content field for hybrid full-text search.
	 */
	private async createPayloadIndexes(): Promise<void> {
		const indexes = [
			// Core indexes (used in most queries)
			{ field: 'workspace', schema: 'keyword' as const, critical: true },
			{ field: 'memory_type', schema: 'keyword' as const, critical: true },
			{ field: 'confidence', schema: 'float' as const, critical: true },
			{ field: 'created_at', schema: 'datetime' as const, critical: false },
			{ field: 'updated_at', schema: 'datetime' as const, critical: false },
			{ field: 'expires_at', schema: 'datetime' as const, critical: true },

			// Optional indexes (for analytics)
			{ field: 'access_count', schema: 'integer' as const, critical: false },
			{ field: 'last_accessed_at', schema: 'datetime' as const, critical: false },
			{ field: 'tags', schema: 'keyword' as const, critical: false },
			{ field: 'chunk_group_id', schema: 'keyword' as const, critical: true },

			// Text index for full-text search
			{ field: 'content', schema: 'text' as const, critical: true },
		];

		logger.info('Creating payload indexes...');

		for (const index of indexes) {
			try {
				await withRetry(() => this.client.createPayloadIndex(this.collectionName, {
					field_name: index.field,
					field_schema: index.schema,
					...(index.schema === 'text' && {
						// Text index configuration
						field_index_params: {
							tokenizer: 'word',
							min_token_len: 2,
							max_token_len: TEXT_INDEX_MAX_TOKEN_LEN,
							lowercase: true,
						},
					}),
				}));
				logger.debug(`Created index for field: ${index.field}`);
			} catch (error) {
				// Ignore if index already exists
				if (error instanceof Error && error.message.includes('already exists')) {
					logger.debug(`Index already exists for field: ${index.field}`);
				} else if (index.critical) {
					// Critical indexes must succeed; propagate errors for these
					logger.error(`Failed to create critical index for ${index.field}:`, error);
					throw error;
				} else {
					// Optional indexes can be skipped; log as warning only
					logger.warn(`Failed to create optional index for ${index.field}:`, error);
				}
			}
		}

		logger.info('Payload indexes created');
	}

	/**
	 * Stores a single point in Qdrant with optional dual embeddings (small and large).
	 *
	 * @param content - The text content to embed and store.
	 * @param vector - The small embedding vector (typically 384 dimensions).
	 * @param metadata - Optional metadata (id, workspace, memory_type, confidence, tags, etc.). If `id` is not provided, a UUID is generated. Timestamps (`created_at`, `updated_at`) default to the current time unless explicitly provided.
	 * @param vectorLarge - Optional large embedding vector (typically 3072 dimensions) for dual-embedding support.
	 * @returns The point ID (UUID).
	 * @throws {Error} If the Qdrant API returns an error after all retry attempts are exhausted.
	 * @example
	 * ```typescript
	 * const id = await qdrantService.upsert(
	 *   'Hello world',
	 *   [0.1, 0.2, ...], // small embedding
	 *   { memory_type: 'long-term', confidence: 0.9 },
	 *   [0.15, 0.25, ...] // large embedding (optional)
	 * );
	 * ```
	 */
	public async upsert(
		content: string,
		vector: number[],
		metadata: Partial<QdrantPayload> = {},
		vectorLarge?: number[],
	): Promise<string> {
		await this.ensureInitialized();

		const id = metadata.id ?? uuidv4();
		const now = new Date().toISOString();

		const payload: QdrantPayload = {
			...metadata,
			content,
			workspace: metadata.workspace ?? null,
			memory_type: metadata.memory_type ?? 'long-term',
			confidence: metadata.confidence ?? DEFAULT_CONFIDENCE,
			tags: metadata.tags ?? [],
			access_count: metadata.access_count ?? 0,
			last_accessed_at: metadata.last_accessed_at ?? null,
			created_at: metadata.created_at ?? now,
			updated_at: metadata.updated_at ?? now,
		};

		const vectorData = { dense: vector, ...(vectorLarge && { dense_large: vectorLarge }) };

		const point: QdrantPoint = {
			id,
			vector: vectorData,
			payload,
		};

		try {
			await withRetry(() => this.client.upsert(this.collectionName, {
				wait: true,
				points: [point],
			}));
		} catch (error) {
			throw new MemoryError('STORAGE_FAILED', `Failed to upsert points to Qdrant: ${extractErrorMessage(error)}`, { cause: error });
		}

		const embeddingType = vectorLarge ? 'dual' : 'single';
		logger.debug(`Upserted point with ${embeddingType} embedding: ${id}`);
		return id;
	}

	/**
	 * Stores multiple points in Qdrant in batches (500 per batch by default).
	 *
	 * Handles failures gracefully: if a batch fails, the failure is recorded but other batches continue processing.
	 *
	 * @param points - Array of points to upsert, each with `content`, `vector`, optional `vectorLarge`, and optional `metadata`.
	 * @returns Object with `successfulIds` (array of UUIDs), `failedPoints` (array of failures with index, id, and error message), and `totalProcessed` (count).
	 * @throws {Error} If initialization fails.
	 * @example
	 * ```typescript
	 * const result = await qdrantService.batchUpsert([
	 *   { content: 'Text 1', vector: [0.1, ...], metadata: { memory_type: 'long-term' } },
	 *   { content: 'Text 2', vector: [0.2, ...], vectorLarge: [0.2, ...] },
	 * ]);
	 * console.log(`${result.successfulIds.length}/${result.totalProcessed} succeeded`);
	 * ```
	 */
	public async batchUpsert(
		points: Array<{
			content: string;
			vector: number[];
			vectorLarge?: number[];
			metadata?: Partial<QdrantPayload>;
		}>,
	): Promise<BatchUpsertResult> {
		await this.ensureInitialized();

		const result: BatchUpsertResult = {
			successfulIds: [],
			failedPoints: [],
			totalProcessed: 0,
		};

		for (let i = 0; i < points.length; i += UPSERT_BATCH_SIZE) {
			const batch = points.slice(i, i + UPSERT_BATCH_SIZE);
			const now = new Date().toISOString();

			const qdrantPoints: QdrantPoint[] = batch.map((p) => {
				const id = p.metadata?.id ?? uuidv4();

				const payload: QdrantPayload = {
					...p.metadata,
					content: p.content,
					workspace: p.metadata?.workspace ?? null,
					memory_type: p.metadata?.memory_type ?? 'long-term',
					confidence: p.metadata?.confidence ?? DEFAULT_CONFIDENCE,
					tags: p.metadata?.tags ?? [],
					access_count: p.metadata?.access_count ?? 0,
					last_accessed_at: p.metadata?.last_accessed_at ?? null,
					created_at: p.metadata?.created_at ?? now,
					updated_at: p.metadata?.updated_at ?? now,
				};

				const vectorData = { dense: p.vector, ...(p.vectorLarge && { dense_large: p.vectorLarge }) };

				return {
					id,
					vector: vectorData,
					payload,
				};
			});

			try {
				await withRetry(() => this.client.upsert(this.collectionName, {
					wait: true,
					points: qdrantPoints,
				}));

				// All points in batch succeeded
				result.successfulIds.push(...qdrantPoints.map((p) => p.id));
				result.totalProcessed += batch.length;

				logger.debug(`Upserted batch ${i / UPSERT_BATCH_SIZE + 1}: ${batch.length} points`);
			} catch (error) {
				// Entire batch failed - record all as failures
				const errorMessage = error instanceof Error ? error.message : String(error);
				qdrantPoints.forEach((point, idx) => {
					result.failedPoints.push({
						index: i + idx,
						id: point.id,
						error: errorMessage,
					});
				});
				result.totalProcessed += batch.length;

				logger.error(`Batch ${i / UPSERT_BATCH_SIZE + 1} failed:`, error);
			}
		}

		const successRate =
			result.totalProcessed > 0
				? ((result.successfulIds.length / result.totalProcessed) * PERCENT).toFixed(1)
				: '0';

		logger.info(
			`Batch upsert completed: ${result.successfulIds.length}/${result.totalProcessed} ` +
        `succeeded (${successRate}%), ${result.failedPoints.length} failed`,
		);

		return result;
	}

	/**
	 * Searches for similar vectors using dense similarity and optional hybrid search (RRF).
	 *
	 * Optionally combines dense vector similarity with full-text keyword search via Reciprocal Rank Fusion (RRF). Automatically tracks access counts on retrieved results.
	 *
	 * @param params - Search parameters including `vector` (required), optional `vectorLarge` for dual-embedding queries, `filter` (workspace, memory_type, confidence, tags), `limit`, `offset`, `scoreThreshold`, and hybrid search options (`useHybridSearch`, `query`, `hybridAlpha`).
	 * @returns Array of search results, each with `id`, `content`, `score` (similarity score), and `metadata`.
	 * @throws {Error} If the Qdrant API returns an error after all retry attempts are exhausted.
	 * @example
	 * ```typescript
	 * const results = await qdrantService.search({
	 *   vector: [0.1, 0.2, ...],
	 *   filter: { workspace: 'my-project', memory_type: 'long-term' },
	 *   limit: 10,
	 *   useHybridSearch: true,
	 *   query: 'search text',
	 * });
	 * ```
	 */
	public async search(params: SearchParams): Promise<SearchResult[]> {
		await this.ensureInitialized();

		const filter = this.buildFilter(params.filter);

		// Use hybrid search with RRF if query text is provided and explicitly enabled
		if (isHybridSearchParams(params)) {
			return this.hybridSearchWithRRF(params, filter);
		}

		const vectorQuery = {
			name: params.vectorLarge ? 'dense_large' : 'dense',
			vector: params.vectorLarge ?? params.vector,
		};

		// Standard vector-only search
		const results = await withRetry(() => this.client.search(this.collectionName, {
			vector: vectorQuery,
			filter,
			limit: params.limit ?? DEFAULT_SEARCH_LIMIT,
			offset: params.offset ?? 0,
			score_threshold: params.scoreThreshold,
			with_payload: params.withPayload !== false,
			with_vector: params.withVector ?? false,
			params: {
				hnsw_ef: params.hnsw_ef ?? DEFAULT_HNSW_EF, // Search thoroughness
				// indexed_only: only search segments that have been fully indexed by HNSW.
				// Points upserted very recently (within the indexing_threshold window) may
				// not appear in results until Qdrant's background indexer processes them.
				indexed_only: true,
			},
		}));

		// Update access tracking (fire-and-forget)
		this.trackAccess(results.map((r) => String(r.id)));

		return results.map((r) => {
			const payload = this.toQdrantPayload(r.payload) ?? {
				content: '',
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};
			return {
				id: String(r.id),
				...(typeof payload.path === 'string' && payload.path ? { path: payload.path } : {}),
				content: typeof payload.content === 'string' ? payload.content : '',
				score: r.score,
				metadata: payload,
			};
		});
	}

	/**
   * Hybrid search using manual RRF (Reciprocal Rank Fusion)
   * Combines dense vector similarity search with full-text index search.
   *
   * Note: the text component uses Qdrant's keyword/full-text index on the `content`
   * field (configured with word tokenisation). It is NOT a BM25 sparse-vector search.
   * "Hybrid" here means vector + full-text fusion via RRF, not dense + sparse vectors.
   */
	private async hybridSearchWithRRF(
		params: HybridSearchParams,
		filter?: Record<string, unknown>,
	): Promise<SearchResult[]> {
		// Pagination is not supported in hybrid search because it requires
		// fusing two separate result sets; offset makes no sense semantically
		if ((params.offset ?? 0) > 0) {
			logger.warn(
				'Hybrid search (RRF) does not support pagination (offset > 0). Returning empty results. ' +
				'Use standard vector search without useHybridSearch=true to enable offset-based pagination.',
			);
			return [];
		}

		const k = RRF_K; // RRF constant (typical value)
		const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;
		const fetchLimit = limit * RRF_FETCH_MULTIPLIER; // Fetch more results for better RRF

		// Perform vector similarity search
		const vectorResults = await withRetry(() => this.client.search(this.collectionName, {
			vector: { name: params.vectorLarge ? 'dense_large' : 'dense', vector: params.vectorLarge ?? params.vector },
			filter,
			limit: fetchLimit,
			score_threshold: params.scoreThreshold,
			with_payload: true,
			with_vector: false,
			params: {
				hnsw_ef: params.hnsw_ef ?? DEFAULT_HNSW_EF,
				indexed_only: true,
			},
		}));

		// Perform text-based search using the text index on content field
		const textFilter = {
			...(filter ?? {}),
			must: [
				...(Array.isArray(filter?.must) ? filter.must : []),
				{
					key: 'content',
					match: { text: params.query },
				},
			],
		};

		const textResults = await withRetry(() => this.client.scroll(this.collectionName, {
			filter: textFilter,
			limit: fetchLimit,
			with_payload: true,
			with_vector: false,
		}));

		// Apply RRF: score = sum(alpha * 1 / (k + rank) for vector + (1 - alpha) * 1 / (k + rank) for text)
		const alpha = params.hybridAlpha ?? DEFAULT_HYBRID_ALPHA; // Default: equal weighting between dense and text
		const rrfScores = new Map<string, number>();
		// Store payloads directly (not whole result objects) for cleaner access
		const payloadsById = new Map<string, Record<string, unknown> | null | undefined>();

		// Add vector search results (weighted by alpha)
		vectorResults.forEach((result, index) => {
			const id = String(result.id);
			const rank = index + 1;
			rrfScores.set(id, (rrfScores.get(id) ?? 0) + alpha * (1 / (k + rank)));
			payloadsById.set(id, result.payload as Record<string, unknown>);
		});

		// Add text search results (weighted by 1 - alpha)
		textResults.points.forEach((result, index) => {
			const id = String(result.id);
			const rank = index + 1;
			rrfScores.set(id, (rrfScores.get(id) ?? 0) + (1 - alpha) * (1 / (k + rank)));
			if (!payloadsById.has(id)) {
				payloadsById.set(id, result.payload as Record<string, unknown>);
			}
		});

		// Sort by RRF score and take top results
		// offset is always 0 here — values > 0 are rejected above
		const sortedResults = Array.from(rrfScores.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.flatMap(([id, score]) => {
				const rawPayload = payloadsById.get(id);
				if (!rawPayload) return [];
				const payload = this.toQdrantPayload(rawPayload) ?? {
					content: '',
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				};
				return [{
					id,
					...(typeof payload.path === 'string' && payload.path ? { path: payload.path } : {}),
					content: typeof payload.content === 'string' ? payload.content : '',
					score,
					metadata: payload,
				}];
			});

		// Update access tracking (fire-and-forget)
		this.trackAccess(sortedResults.map((r) => r.id));

		logger.debug(
			`Hybrid search with RRF: ${vectorResults.length} vector + ${textResults.points.length} text results → ${sortedResults.length} final`,
		);

		return sortedResults;
	}

	/**
	 * Retrieves a single point by ID.
	 *
	 * Automatically tracks the access count and last-accessed timestamp.
	 *
	 * @param id - The UUID of the point to retrieve.
	 * @returns The search result with full content and metadata, or `null` if the point does not exist.
	 * @throws {Error} If the Qdrant API returns an error after all retry attempts are exhausted.
	 * @example
	 * ```typescript
	 * const point = await qdrantService.get('550e8400-e29b-41d4-a716-446655440000');
	 * if (point) {
	 *   console.log(point.content, point.metadata);
	 * }
	 * ```
	 */
	public async get(id: string): Promise<SearchResult | null> {
		await this.ensureInitialized();

		const result = await withRetry(() => this.client.retrieve(this.collectionName, {
			ids: [id],
			with_payload: true,
			with_vector: false,
		}));

		if (result.length === 0) {
			return null;
		}

		const [point] = result;

		// Update access tracking (fire-and-forget)
		this.trackAccess([id]);

		const payload = this.toQdrantPayload(point.payload) ?? {
			content: '',
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		return {
			id: String(point.id),
			...(typeof payload.path === 'string' && payload.path ? { path: payload.path } : {}),
			content: typeof payload.content === 'string' ? payload.content : '',
			score: 1.0,
			metadata: payload,
		};
	}

	/**
	 * Deletes a single point by ID.
	 *
	 * @param id - The UUID of the point to delete.
	 * @returns Resolves when the deletion completes successfully.
	 * @throws {Error} If the Qdrant API returns an error after all retry attempts are exhausted.
	 * @example
	 * ```typescript
	 * await qdrantService.delete('550e8400-e29b-41d4-a716-446655440000');
	 * ```
	 */
	public async delete(id: string): Promise<void> {
		await this.ensureInitialized();

		await withRetry(() => this.client.delete(this.collectionName, {
			wait: true,
			points: [id],
		}));

		logger.debug(`Deleted point: ${id}`);
	}

	/**
	 * Deletes multiple points by IDs in a single Qdrant operation.
	 *
	 * @param ids - Array of point UUIDs to delete (max 100 for practical limits).
	 * @returns Resolves when the batch deletion completes successfully.
	 * @throws {Error} If the Qdrant API returns an error after all retry attempts are exhausted.
	 * @example
	 * ```typescript
	 * await qdrantService.batchDelete(['id1', 'id2', 'id3']);
	 * ```
	 */
	public async batchDelete(ids: string[]): Promise<void> {
		if (ids.length === 0) {
			return;
		}

		await this.ensureInitialized();

		await withRetry(() => this.client.delete(this.collectionName, {
			wait: true,
			points: ids,
		}));

		logger.info(`Batch delete completed: ${ids.length} points`);
	}

	/**
	 * Lists points with optional filtering, pagination, and sorting.
	 *
	 * Uses Qdrant's scroll API to fetch results without payload vectors.
	 *
	 * @param filter - Optional filter criteria (workspace, memory_type, confidence, tags, metadata).
	 * @param limit - Number of results per page (default 100, max 1000).
	 * @param offset - Pagination offset (0-based).
	 * @returns Array of search results (one page) with full content and metadata.
	 * @throws {Error} If the Qdrant API returns an error after all retry attempts are exhausted.
	 * @example
	 * ```typescript
	 * const page = await qdrantService.list(
	 *   { workspace: 'my-project', memory_type: 'long-term' },
	 *   100,
	 *   0
	 * );
	 * ```
	 */
	public async list(
		filter?: SearchFilters,
		limit: number = DEFAULT_LIST_LIMIT,
		offset: number = 0,
	): Promise<SearchResult[]> {
		await this.ensureInitialized();

		const qdrantFilter = this.buildFilter(filter);

		const results = await withRetry(() => this.client.scroll(this.collectionName, {
			filter: qdrantFilter,
			limit,
			offset,
			with_payload: true,
			with_vector: false,
		}));

		return results.points.map((p) => {
			const payload = this.toQdrantPayload(p.payload) ?? {
				content: '',
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};
			return {
				id: String(p.id),
				...(typeof payload.path === 'string' && payload.path ? { path: payload.path } : {}),
				content: typeof payload.content === 'string' ? payload.content : '',
				score: 1.0,
				metadata: payload,
			};
		});
	}

	/**
	 * Retrieves collection statistics including point count, indexed vector count, segment count, and optimizer status.
	 *
	 * Also includes the cumulative count of access-tracking update failures since service start for diagnostics.
	 *
	 * @returns Collection statistics object with point counts, indexing status, and optimizer health.
	 * @throws {Error} If the Qdrant API returns an error after all retry attempts are exhausted.
	 * @example
	 * ```typescript
	 * const stats = await qdrantService.getStats();
	 * console.log(`${stats.points_count} points, ${stats.indexed_vectors_count} indexed`);
	 * ```
	 */
	public async getStats(): Promise<CollectionStats> {
		await this.ensureInitialized();

		const info = await withRetry(() => this.client.getCollection(this.collectionName));

		return {
			indexed_vectors_count: info.indexed_vectors_count ?? 0,
			points_count: info.points_count ?? 0,
			segments_count: info.segments_count ?? 0,
			status: info.status,
			optimizer_status: normalizeOptimizerStatus(info.optimizer_status),
			config: info.config,
			access_tracking_failures: this.accessTrackingFailureCount,
		};
	}

	/**
	 * Counts points matching optional filter criteria.
	 *
	 * Uses Qdrant's approximate counting mode for performance; exact counts are not guaranteed.
	 *
	 * @param filter - Optional filter criteria (workspace, memory_type, confidence, tags, metadata).
	 * @returns The approximate count of matching points.
	 * @throws {Error} If the Qdrant API returns an error after all retry attempts are exhausted.
	 * @example
	 * ```typescript
	 * const total = await qdrantService.count({ memory_type: 'long-term' });
	 * console.log(`${total} long-term memories`);
	 * ```
	 */
	public async count(filter?: SearchFilters): Promise<number> {
		await this.ensureInitialized();

		const qdrantFilter = this.buildFilter(filter);

		const result = await withRetry(() => this.client.count(this.collectionName, {
			filter: qdrantFilter,
			exact: false, // Use approximate count for speed
		}));

		return result.count;
	}

	/**
	 * Updates metadata (payload) for a single point without modifying the embedding.
	 *
	 * Automatically updates the `updated_at` timestamp to the current time.
	 *
	 * @param id - The UUID of the point to update.
	 * @param payload - Partial metadata object with fields to update (memory_type, confidence, tags, etc.).
	 * @returns Resolves when the payload update completes successfully.
	 * @throws {Error} If the Qdrant API returns an error after all retry attempts are exhausted.
	 * @example
	 * ```typescript
	 * await qdrantService.updatePayload('550e8400-e29b-41d4-a716-446655440000', {
	 *   confidence: 0.95,
	 *   tags: ['important', 'verified'],
	 * });
	 * ```
	 */
	public async updatePayload(
		id: string,
		payload: Partial<QdrantPayload>,
	): Promise<void> {
		await this.ensureInitialized();

		await withRetry(() => this.client.setPayload(this.collectionName, {
			wait: true,
			points: [id],
			payload: {
				...payload,
				updated_at: new Date().toISOString(),
			},
		}));

		logger.debug(`Updated payload for point: ${id}`);
	}

	/**
	 * Builds a Qdrant filter from application-level {@link SearchFilters}.
	 *
	 * The expiry condition (`expires_at` is null OR > now) is **always** appended,
	 * even when `filter` is `undefined`, so expired memories are excluded from
	 * every `list`, `count`, and `search` call regardless of whether the caller
	 * supplies other filter criteria.
	 *
	 * @param filter - Optional caller-supplied filter criteria.
	 * @returns A Qdrant `must` filter object (always includes at minimum the expiry condition).
	 */
	private buildFilter(filter?: SearchFilters): Record<string, unknown> {
		const conditions: Array<Record<string, unknown>> = [];

		if (filter) {
			// Workspace filter
			if (filter.workspace !== undefined) {
				if (filter.workspace === null) {
					// When workspace is explicitly null, match memories with no workspace
					conditions.push({
						is_null: { key: 'workspace' },
					});
				} else {
					conditions.push({
						key: 'workspace',
						match: { value: filter.workspace },
					});
				}
			}

			// Memory type filter
			if (filter.memory_type) {
				conditions.push({
					key: 'memory_type',
					match: { value: filter.memory_type },
				});
			}

			// Confidence filter (minimum threshold)
			if (filter.min_confidence !== undefined) {
				conditions.push({
					key: 'confidence',
					range: { gte: filter.min_confidence },
				});
			}

			// Tags filter (match any)
			if (filter.tags && filter.tags.length > 0) {
				conditions.push({
					key: 'tags',
					match: { any: filter.tags },
				});
			}

			// Custom metadata filters
			if (filter.metadata) {
				for (const [key, value] of Object.entries(filter.metadata)) {
					conditions.push({
						key,
						match: { value },
					});
				}
			}
		}

		// Always exclude expired memories — this condition is unconditional so that
		// callers that pass no filter still see only non-expired memories.
		const now = new Date().toISOString();
		conditions.push({
			should: [
				{ is_null: { key: 'expires_at' } },
				{ key: 'expires_at', range: { gt: now } },
			],
		});

		return { must: conditions };
	}

	/**
	 * Update access tracking for retrieved points.
	 *
	 * Implements read-modify-write sequence: fetches current access_count,
	 * increments it, then updates the point. Under concurrent access, the count
	 * may be undercounted, but access_count is an analytic field and eventual
	 * consistency is acceptable.
	 *
	 * @param ids - Array of point IDs to update.
	 * @returns Promise<void>
	 * @throws {Error} If setPayload fails during update.
	 * @example
	 * ```typescript
	 * // Called internally after point retrieval
	 * await service.updateAccessTracking(['id1', 'id2']);
	 * ```
	 */
	private async updateAccessTracking(ids: string[]): Promise<void> {
		const now = new Date().toISOString();

		// Read-modify-write: fetch current state, increment, write back
		// Fetch all points to get their current access_count values
		const points = await withRetry(() =>
			this.client.retrieve(this.collectionName, {
				ids,
				with_payload: true,
				with_vector: false,
			}),
		);

		if (points.length === 0) {
			logger.debug(`No points found for access tracking update: ${ids.length} requested`);
			return;
		}

		// Update each point's access_count and last_accessed_at
		// setPayload merges the provided payload with existing payload
		await Promise.all(
			points.map((point) => {
				// Type guard: extract access_count from payload
				const currentCount = typeof point.payload?.access_count === 'number'
					? point.payload.access_count
					: 0;

				return withRetry(() =>
					this.client.setPayload(this.collectionName, {
						wait: false,
						points: [point.id],
						payload: {
							access_count: currentCount + 1,
							last_accessed_at: now,
						},
					}),
				);
			}),
		);
	}

	/**
	 * Convert a Qdrant point payload to the typed QdrantPayload shape.
	 * Safely narrows from unknown to the expected structure, returning null
	 * if the payload is missing or invalid.
	 *
	 * @param payload - The raw payload from a Qdrant point (may be any type).
	 * @returns QdrantPayload | null - The typed payload, or null if narrowing fails.
	 * @example
	 * ```typescript
	 * const payload = point.payload;
	 * const typed = service.toQdrantPayload(payload);
	 * if (typed !== null) {
	 *   console.log(typed.content);
	 * }
	 * ```
	 */
	private toQdrantPayload(payload: unknown): QdrantPayload | null {
		if (!isQdrantPayload(payload)) {
			logger.warn('Invalid payload structure — missing required fields (content, created_at, updated_at)');
			return null;
		}
		return payload;
	}

	/**
	 * Track access to retrieved points with rate-limited error logging.
	 *
	 * Fire-and-forget operation: updates access_count and last_accessed_at
	 * without blocking the caller. Failures are logged at most once per
	 * {@link ACCESS_TRACKING_WARNING_INTERVAL_MS} to avoid log spam.
	 *
	 * @param ids - Array of point IDs to track.
	 * @returns void
	 * @throws Does not throw; errors are caught and logged internally.
	 */
	private trackAccess(ids: string[]): void {
		if (ids.length === 0) return;

		this.updateAccessTracking(ids).catch((err: unknown) => {
			this.accessTrackingFailureCount++;
			// Rate-limit warning logs: only log if at least 10 seconds have passed
			const now = Date.now();
			if (now - this.lastTrackingWarningTime >= ACCESS_TRACKING_WARNING_INTERVAL_MS) {
				this.lastTrackingWarningTime = now;
				logger.warn(
					`Failed to update access tracking (${this.accessTrackingFailureCount} total failures):`,
					err,
				);
			}
		});
	}

	/**
	 * Ensures the service is initialized before use.
	 * Delegates to `initialize()` which is idempotent.
	 */
	private async ensureInitialized(): Promise<void> {
		await this.initialize();
	}
}

/**
 * Singleton Qdrant service instance for the entire application.
 *
 * @example
 * ```typescript
 * import { qdrantService } from './services/qdrant-client.js';
 * await qdrantService.initialize();
 * const searchResults = await qdrantService.search(embedding, { limit: 10 });
 * await qdrantService.store({ id: 'mem-1', content: '...', embedding: [...] });
 * ```
 */
export const qdrantService = new QdrantService();
