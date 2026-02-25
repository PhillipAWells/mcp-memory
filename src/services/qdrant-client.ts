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

/**
 * Point structure for Qdrant upsert
 */
interface QdrantPoint {
	id: string;
	vector: number[] | { dense?: number[]; sparse?: number[] };
	payload: QdrantPayload;
}

/**
 * Batch upsert result
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
	hybridAlpha?: number; // Weight between dense (1.0) and sparse (0.0) search, default 0.5
	// Dual embedding options
}

/**
 * Collection statistics
 */
interface CollectionStats {
	vectors_count: number;
	indexed_vectors_count: number;
	points_count: number;
	segments_count: number;
	status: string;
	optimizer_status: string;
	config: any;
	/** Cumulative count of access-tracking update failures since service start. */
	access_tracking_failures: number;
}

/**
 * Qdrant Client Service
 *
 * Manages vector database operations with optimized configuration
 */
export class QdrantService {
	private readonly client: QdrantClient;
	private readonly collectionName: string;
	private initialized: boolean = false;
	/** Running count of access-tracking update failures for diagnostics. */
	private accessTrackingFailureCount: number = 0;
	/** Timestamp of the last access tracking warning log (for rate-limiting). */
	private lastTrackingWarningTime: number = 0;

	constructor() {
		this.collectionName = config.qdrant.collection;

		// Initialize Qdrant client
		this.client = new QdrantClient({
			url: config.qdrant.url,
			apiKey: config.qdrant.apiKey,
			timeout: config.qdrant.timeout,
		});

		logger.info(`Qdrant client initialized: ${config.qdrant.url}`);
	}

	/**
   * Initialize the collection with optimized configuration
   */
	public async initialize(): Promise<void> {
		if (this.initialized) {
			logger.debug('Qdrant service already initialized');
			return;
		}

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

			this.initialized = true;
			logger.info('Qdrant service initialized successfully');
		} catch (error) {
			logger.error('Failed to initialize Qdrant service:', error);
			throw error;
		}
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

		const namedVectors = vectors as Record<string, { size?: number; distance?: string }>;

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
   * Create collection with production-optimized configuration
   * Supports hybrid search via text index + vector search with manual RRF
   * Supports dual embeddings (small + large) when enabled
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
   * Create payload indexes for all filterable fields
   */
	private async createPayloadIndexes(): Promise<void> {
		const indexes = [
			// Core indexes (used in most queries)
			{ field: 'workspace', schema: 'keyword' as const },
			{ field: 'memory_type', schema: 'keyword' as const },
			{ field: 'confidence', schema: 'float' as const },
			{ field: 'created_at', schema: 'datetime' as const },
			{ field: 'updated_at', schema: 'datetime' as const },

			// Optional indexes (for analytics)
			{ field: 'access_count', schema: 'integer' as const },
			{ field: 'last_accessed_at', schema: 'datetime' as const },
			{ field: 'tags', schema: 'keyword' as const },

			// Text index for full-text search
			{ field: 'content', schema: 'text' as const },
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
				} else {
					logger.warn(`Failed to create index for ${index.field}:`, error);
				}
			}
		}

		logger.info('Payload indexes created');
	}

	/**
   * Upsert a single point
   * Supports dual embeddings (small + large) when enabled
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
			content,
			workspace: metadata.workspace ?? null,
			memory_type: metadata.memory_type ?? 'long-term',
			confidence: metadata.confidence ?? DEFAULT_CONFIDENCE,
			tags: metadata.tags ?? [],
			created_at: metadata.created_at ?? now,
			updated_at: now,
			access_count: metadata.access_count ?? 0,
			last_accessed_at: metadata.last_accessed_at ?? null,
			...metadata,
		};

		const vectorData = { dense: vector, dense_large: vectorLarge };

		const point: QdrantPoint = {
			id,
			vector: vectorData,
			payload,
		};

		await withRetry(() => this.client.upsert(this.collectionName, {
			wait: true,
			points: [point],
		}));

		const embeddingType = vectorLarge ? 'dual' : 'single';
		logger.debug(`Upserted point with ${embeddingType} embedding: ${id}`);
		return id;
	}

	/**
   * Batch upsert multiple points with error tracking
   * Supports dual embeddings (small + large) when enabled
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
					content: p.content,
					workspace: p.metadata?.workspace ?? null,
					memory_type: p.metadata?.memory_type ?? 'long-term',
					confidence: p.metadata?.confidence ?? DEFAULT_CONFIDENCE,
					tags: p.metadata?.tags ?? [],
					created_at: p.metadata?.created_at ?? now,
					updated_at: now,
					access_count: p.metadata?.access_count ?? 0,
					last_accessed_at: p.metadata?.last_accessed_at ?? null,
					...p.metadata,
				};

				const vectorData = { dense: p.vector, dense_large: p.vectorLarge };

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
				qdrantPoints.forEach((point, idx) => {
					result.failedPoints.push({
						index: i + idx,
						id: point.id,
						error: error instanceof Error ? error.message : String(error),
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
   * Search for similar vectors with optional hybrid search (RRF)
   */
	public async search(params: SearchParams): Promise<SearchResult[]> {
		await this.ensureInitialized();

		const filter = this.buildFilter(params.filter);

		// Use hybrid search with RRF if query text is provided and explicitly enabled
		if (params.useHybridSearch && params.query) {
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
		const resultIds = results.map((r) => String(r.id));
		if (resultIds.length > 0) {
			this.updateAccessTracking(resultIds).catch((err) => {
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

		return results.map((r) => ({
			id: String(r.id),
			path: (r.payload?.path as string) || '',
			content: (r.payload?.content as string) || '',
			score: r.score,
			metadata: r.payload as unknown as QdrantPayload,
		}));
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
		params: SearchParams,
		filter: any,
	): Promise<SearchResult[]> {
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
		const queryText = params.query as string;
		const textFilter = {
			...filter,
			must: [
				...(filter?.must ?? []),
				{
					key: 'content',
					match: { text: queryText },
				},
			],
		};

		const textResults = await withRetry(() => this.client.scroll(this.collectionName, {
			filter: textFilter,
			limit: fetchLimit,
			with_payload: true,
			with_vector: false,
		}));

		// Apply RRF: score = sum(1 / (k + rank))
		const rrfScores = new Map<string, number>();
		const pointsById = new Map<string, any>();

		// Add vector search results
		vectorResults.forEach((result, index) => {
			const id = String(result.id);
			const rank = index + 1;
			rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (k + rank));
			pointsById.set(id, result);
		});

		// Add text search results
		textResults.points.forEach((result, index) => {
			const id = String(result.id);
			const rank = index + 1;
			rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (k + rank));
			if (!pointsById.has(id)) {
				pointsById.set(id, result);
			}
		});

		// Sort by RRF score and take top results
		const sortedResults = Array.from(rrfScores.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(params.offset ?? 0, (params.offset ?? 0) + limit)
			.flatMap(([id, score]) => {
				const point = pointsById.get(id);
				if (!point) return [];
				return [{
					id,
					path: (point.payload?.path as string) || '',
					content: (point.payload?.content as string) || '',
					score,
					metadata: point.payload as unknown as QdrantPayload,
				}];
			});

		// Update access tracking (fire-and-forget)
		const resultIds = sortedResults.map((r) => r.id);
		if (resultIds.length > 0) {
			this.updateAccessTracking(resultIds).catch((err) => {
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

		logger.debug(
			`Hybrid search with RRF: ${vectorResults.length} vector + ${textResults.points.length} text results → ${sortedResults.length} final`,
		);

		return sortedResults;
	}

	/**
   * Get a point by ID
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
		this.updateAccessTracking([id]).catch((err) =>
			logger.warn('Failed to update access tracking:', err),
		);

		return {
			id: String(point.id),
			path: (point.payload?.path as string) || '',
			content: (point.payload?.content as string) || '',
			score: 1.0,
			metadata: point.payload as unknown as QdrantPayload,
		};
	}

	/**
   * Delete a point by ID
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
   * Delete multiple points by IDs
   */
	public async batchDelete(ids: string[]): Promise<void> {
		await this.ensureInitialized();

		await withRetry(() => this.client.delete(this.collectionName, {
			wait: true,
			points: ids,
		}));

		logger.info(`Batch delete completed: ${ids.length} points`);
	}

	/**
   * List all points with optional filtering
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

		return results.points.map((p) => ({
			id: String(p.id),
			path: (p.payload?.path as string) || '',
			content: (p.payload?.content as string) || '',
			score: 1.0,
			metadata: p.payload as unknown as QdrantPayload,
		}));
	}

	/**
   * Get collection statistics
   */
	public async getStats(): Promise<CollectionStats> {
		await this.ensureInitialized();

		const info = await withRetry(() => this.client.getCollection(this.collectionName));

		return {
			vectors_count: info.points_count ?? 0,
			indexed_vectors_count: info.indexed_vectors_count ?? 0,
			points_count: info.points_count ?? 0,
			segments_count: info.segments_count ?? 0,
			status: info.status,
			optimizer_status: typeof info.optimizer_status === 'string'
				? info.optimizer_status
				: 'error' in info.optimizer_status
					? 'error'
					: 'ok',
			config: info.config,
			access_tracking_failures: this.accessTrackingFailureCount,
		};
	}

	/**
   * Count points matching filter
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
   * Update point payload (metadata)
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
   * Build Qdrant filter from SearchFilters
   */
	private buildFilter(filter?: SearchFilters): any {
		if (!filter) return undefined;

		const conditions: any[] = [];

		// Workspace filter
		if (filter.workspace !== undefined) {
			conditions.push({
				key: 'workspace',
				match: { value: filter.workspace },
			});
		}

		// Memory type filter
		if (filter.memory_type) {
			conditions.push({
				key: 'memory_type',
				match: { value: filter.memory_type },
			});
		}

		// Confidence filter (minimum threshold)
		if (filter.minConfidence !== undefined) {
			conditions.push({
				key: 'confidence',
				range: { gte: filter.minConfidence },
			});
		}

		// Always exclude expired memories
		const now = new Date().toISOString();
		conditions.push({
			should: [
				{ key: 'expires_at', match: { value: null } },
				{ key: 'expires_at', range: { gt: now } },
			],
		});

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

		return conditions.length > 0 ? { must: conditions } : undefined;
	}

	/**
   * Update access tracking for retrieved points.
   *
   * Known limitation: this is a read-modify-write sequence (retrieve → increment → setPayload)
   * with no atomic guarantee. Under concurrent access the count may be undercounted, but
   * access_count is an analytic field and eventual consistency is acceptable here.
   */
	private async updateAccessTracking(ids: string[]): Promise<void> {
		const now = new Date().toISOString();

		// Get current access counts
		const points = await this.client.retrieve(this.collectionName, {
			ids,
			with_payload: true,
		});

		// Update each point
		for (const point of points) {
			const currentCount = (point.payload?.access_count as number) || 0;

			await this.client.setPayload(this.collectionName, {
				wait: false, // Don't wait for completion
				points: [point.id],
				payload: {
					access_count: currentCount + 1,
					last_accessed_at: now,
				},
			});
		}

		logger.debug(`Updated access tracking for ${ids.length} points`);
	}

	/**
   * Ensure service is initialized
   */
	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) {
			await this.initialize();
		}
	}

	/**
   * Close the client connection
   */
	public close(): void {
		// QdrantClient doesn't have explicit close method
		// but we can mark as uninitialized
		this.initialized = false;
		logger.info('Qdrant client closed');
	}
}

// Export singleton instance
export const qdrantService = new QdrantService();
