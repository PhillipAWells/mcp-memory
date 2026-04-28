/**
 * Embedding Service
 *
 * Generates embeddings using OpenAI text-embedding-3-small / text-embedding-3-large,
 * with LRU caching and cost tracking.
 */

import { createHash } from 'node:crypto';

import OpenAI from 'openai';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import type { EmbeddingStats } from '../types/index.js';

/**
 * LRU Cache entry
 */
interface CacheEntry {
	embedding: number[];
	timestamp: number;
	hits: number;
}

/** Max number of texts in a single OpenAI embedding batch request. */
const BATCH_SIZE = 100;
/** Top N cache entries returned in getCacheStats. */
const CACHE_STATS_TOP_N = 10;
/** Approximate characters per token (used for token estimation). */
const CHARS_PER_TOKEN = 4;
/** Tokens per million (used for cost calculation). */
const TOKENS_PER_MILLION = 1_000_000;
/** Maximum number of significant digits for cost logging. */
const COST_LOG_PRECISION = 6;
/** Truncation length for debug log messages. */
const DEBUG_TRUNCATE_LEN = 50;
/** Max LRU cache size. */
const MAX_CACHE_SIZE = 10_000;
/** Cost per 1M tokens for text-embedding-3-small (USD). */
const COST_PER_MILLION_TOKENS_SMALL = 0.02;
/** Cost per 1M tokens for text-embedding-3-large (USD). */
const COST_PER_MILLION_TOKENS_LARGE = 0.13;
/** Multiply a fraction by this to convert to a percentage. */
const PERCENT = 100;
/** HTTP 429 Too Many Requests — rate limit hit, safe to retry. */
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
/** HTTP 500 Internal Server Error — transient server failure, safe to retry. */
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;
/** HTTP 502 Bad Gateway — upstream proxy/server error, safe to retry. */
const HTTP_STATUS_BAD_GATEWAY = 502;
/** HTTP 503 Service Unavailable — server overloaded or down, safe to retry. */
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
/** HTTP 504 Gateway Timeout — upstream timeout, safe to retry. */
const HTTP_STATUS_GATEWAY_TIMEOUT = 504;
/** OpenAI text-embedding-3-small model identifier. */
const SMALL_MODEL = 'text-embedding-3-small';
/** OpenAI text-embedding-3-large model identifier. */
const LARGE_MODEL = 'text-embedding-3-large';

/**
 * Embedding Service
 *
 * Generates embeddings using OpenAI text-embedding-3-small and
 * text-embedding-3-large with LRU caching and cost tracking.
 */
export class EmbeddingService {
	private readonly client: OpenAI;
	private readonly cache: Map<string, CacheEntry>;
	private readonly maxCacheSize: number = MAX_CACHE_SIZE;

	private readonly SMALL_DIMENSIONS: number;
	private readonly LARGE_DIMENSIONS: number;

	// Mutable: incremented by embedding operations for cost tracking
	private totalEmbeddings: number = 0;
	private cacheHits: number = 0;
	private cacheMisses: number = 0;
	private totalTokens: number = 0;
	private totalCost: number = 0;

	constructor() {
		this.SMALL_DIMENSIONS = config.embedding.smallDimensions;
		this.LARGE_DIMENSIONS = config.embedding.largeDimensions;
		this.cache = new Map();
		this.client = new OpenAI({ apiKey: config.openai.apiKey });
		logger.info(`Embedding service initialized (model: ${SMALL_MODEL})`);
		logger.debug(`Max cache size: ${this.maxCacheSize}`);
	}

	/**
	 * Generates a single embedding using text-embedding-3-small.
	 *
	 * Checks the LRU cache first; if a hit is found, the cached embedding is returned. Otherwise, the text is sent to OpenAI and the result is cached.
	 *
	 * @param text - The text to embed.
	 * @returns A vector of dimensions matching `SMALL_DIMENSIONS` (typically 384).
	 * @throws {Error} If the OpenAI API returns an error after all retry attempts are exhausted, or if the returned embedding has invalid dimensions.
	 * @example
	 * ```typescript
	 * const embedding = await embeddingService.generateEmbedding('Hello world');
	 * console.log(embedding.length); // 384
	 * ```
	 */
	public async generateEmbedding(text: string): Promise<number[]> {
		this.totalEmbeddings++;

		const cacheKey = this.getCacheKey(text, 'small');

		const cached = this.cache.get(cacheKey);
		if (cached) {
			this.cacheHits++;
			// Move to end of Map to mark as most-recently used (O(1) LRU promotion)
			this.cache.delete(cacheKey);
			cached.hits++;
			cached.timestamp = Date.now();
			this.cache.set(cacheKey, cached);
			logger.debug(`Cache hit for text: "${this.truncate(text, DEBUG_TRUNCATE_LEN)}"`);
			return cached.embedding;
		}

		this.cacheMisses++;
		logger.debug(`Generating embedding for text: "${this.truncate(text, DEBUG_TRUNCATE_LEN)}"`);

		const embedding = await this.generateOpenAIEmbedding(text, SMALL_MODEL, this.SMALL_DIMENSIONS);

		this.addToCache(cacheKey, embedding);
		return embedding;
	}

	/**
	 * Generates a single embedding using text-embedding-3-large.
	 *
	 * Checks the LRU cache first; if a hit is found, the cached embedding is returned. Otherwise, the text is sent to OpenAI and the result is cached.
	 *
	 * @param text - The text to embed.
	 * @returns A vector of dimensions matching `LARGE_DIMENSIONS` (typically 3072).
	 * @throws {Error} If the OpenAI API returns an error after all retry attempts are exhausted, or if the returned embedding has invalid dimensions.
	 * @example
	 * ```typescript
	 * const embedding = await embeddingService.generateLargeEmbedding('Hello world');
	 * console.log(embedding.length); // 3072
	 * ```
	 */
	public async generateLargeEmbedding(text: string): Promise<number[]> {
		this.totalEmbeddings++;

		const cacheKey = this.getCacheKey(text, 'large');

		const cached = this.cache.get(cacheKey);
		if (cached) {
			this.cacheHits++;
			// Move to end of Map to mark as most-recently used (O(1) LRU promotion)
			this.cache.delete(cacheKey);
			cached.hits++;
			cached.timestamp = Date.now();
			this.cache.set(cacheKey, cached);
			logger.debug(`Cache hit (large) for text: "${this.truncate(text, DEBUG_TRUNCATE_LEN)}"`);
			return cached.embedding;
		}

		this.cacheMisses++;
		logger.debug(`Generating large embedding for text: "${this.truncate(text, DEBUG_TRUNCATE_LEN)}"`);

		const embedding = await this.generateOpenAIEmbedding(text, LARGE_MODEL, this.LARGE_DIMENSIONS);

		this.addToCache(cacheKey, embedding);
		return embedding;
	}

	/**
	 * Generates both small and large embeddings for a single text in parallel.
	 *
	 * @param text - The text to embed.
	 * @returns Object with `small` (384d) and `large` (3072d) embedding vectors.
	 * @throws {Error} If either OpenAI API call fails after all retry attempts are exhausted.
	 * @example
	 * ```typescript
	 * const { small, large } = await embeddingService.generateDualEmbeddings('Hello world');
	 * console.log(small.length, large.length); // 384, 3072
	 * ```
	 */
	public async generateDualEmbeddings(text: string): Promise<{
		small: number[];
		large: number[];
	}> {
		const [small, large] = await Promise.all([
			this.generateEmbedding(text),
			this.generateLargeEmbedding(text),
		]);
		logger.debug('Dual embeddings generated (parallel)');
		return { small, large };
	}

	/**
	 * Generates embeddings for multiple texts using text-embedding-3-small.
	 *
	 * Processes texts in batches of up to 100 per OpenAI API call. Checks the cache first for each text; only uncached texts are sent to the API.
	 *
	 * @param texts - Array of texts to embed.
	 * @returns Array of embedding vectors (one per input text) in the same order as `texts`. Each vector has dimensions matching `SMALL_DIMENSIONS`.
	 * @throws {Error} If the OpenAI API returns an error after all retry attempts are exhausted, or if embedding generation is incomplete.
	 * @example
	 * ```typescript
	 * const embeddings = await embeddingService.generateBatchEmbeddings(['Text 1', 'Text 2', 'Text 3']);
	 * console.log(embeddings.length); // 3
	 * ```
	 */
	public async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
		logger.info(`Generating batch embeddings: ${texts.length} texts`);
		this.totalEmbeddings += texts.length;

		const embeddings: number[][] = [];
		for (let i = 0; i < texts.length; i += BATCH_SIZE) {
			const batch = texts.slice(i, i + BATCH_SIZE);
			const batchResults = await this.generateOpenAIBatch(
				batch,
				SMALL_MODEL,
				this.SMALL_DIMENSIONS,
				'small',
			);
			embeddings.push(...batchResults);
			logger.debug(
				`Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(texts.length / BATCH_SIZE)} completed`,
			);
		}

		logger.info(`Batch embeddings completed: ${embeddings.length} embeddings`);
		return embeddings;
	}

	/**
	 * Generates embeddings for multiple texts using text-embedding-3-large.
	 *
	 * Processes texts in batches of up to 100 per OpenAI API call. Checks the cache first for each text; only uncached texts are sent to the API.
	 *
	 * @param texts - Array of texts to embed.
	 * @returns Array of embedding vectors (one per input text) in the same order as `texts`. Each vector has dimensions matching `LARGE_DIMENSIONS`.
	 * @throws {Error} If the OpenAI API returns an error after all retry attempts are exhausted, or if embedding generation is incomplete.
	 * @example
	 * ```typescript
	 * const embeddings = await embeddingService.generateBatchLargeEmbeddings(['Text 1', 'Text 2', 'Text 3']);
	 * console.log(embeddings.length); // 3
	 * ```
	 */
	public async generateBatchLargeEmbeddings(texts: string[]): Promise<number[][]> {
		logger.info(`Generating batch large embeddings: ${texts.length} texts`);
		this.totalEmbeddings += texts.length;

		const embeddings: number[][] = [];
		for (let i = 0; i < texts.length; i += BATCH_SIZE) {
			const batch = texts.slice(i, i + BATCH_SIZE);
			const batchResults = await this.generateOpenAIBatch(
				batch,
				LARGE_MODEL,
				this.LARGE_DIMENSIONS,
				'large',
			);
			embeddings.push(...batchResults);
			logger.debug(
				`Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(texts.length / BATCH_SIZE)} completed (large)`,
			);
		}

		logger.info(`Batch large embeddings completed: ${embeddings.length} embeddings`);
		return embeddings;
	}

	/**
	 * Returns embedding usage statistics.
	 *
	 * @returns Object with `totalEmbeddings` (count), `cacheHits`, `cacheMisses`, `totalTokens`, `totalCost` (USD), and `cacheHitRate` (0–1).
	 * @example
	 * ```typescript
	 * const stats = embeddingService.getStats();
	 * console.log(`Cache hit rate: ${(stats.cacheHitRate * 100).toFixed(1)}%`);
	 * console.log(`Total cost: $${stats.totalCost.toFixed(4)}`);
	 * ```
	 */
	public getStats(): EmbeddingStats {
		const cacheHitRate =
			this.totalEmbeddings > 0 ? this.cacheHits / this.totalEmbeddings : 0;

		return {
			totalEmbeddings: this.totalEmbeddings,
			cacheHits: this.cacheHits,
			cacheMisses: this.cacheMisses,
			totalTokens: this.totalTokens,
			totalCost: this.totalCost,
			cacheHitRate,
		};
	}

	/**
	 * Returns detailed LRU cache statistics.
	 *
	 * @returns Object with `size` (current entries), `maxSize` (capacity), `utilizationPercent` (0–100), and `entries` (top 10 most-accessed cache entries with key, hit count, and age in ms).
	 * @example
	 * ```typescript
	 * const cacheStats = embeddingService.getCacheStats();
	 * console.log(`Cache: ${cacheStats.size}/${cacheStats.maxSize} entries (${cacheStats.utilizationPercent.toFixed(1)}%)`);
	 * ```
	 */
	public getCacheStats(): {
		size: number;
		maxSize: number;
		utilizationPercent: number;
		entries: Array<{ key: string; hits: number; age: number }>;
	} {
		return {
			size: this.cache.size,
			maxSize: this.maxCacheSize,
			utilizationPercent: (this.cache.size / this.maxCacheSize) * PERCENT,
			entries: Array.from(this.cache.entries())
				.map(([key, entry]) => ({
					key,
					hits: entry.hits,
					age: Date.now() - entry.timestamp,
				}))
				.sort((a, b) => b.hits - a.hits)
				.slice(0, CACHE_STATS_TOP_N),
		};
	}

	/**
	 * Resets all embedding usage statistics.
	 *
	 * Clears cumulative counters for embeddings, cache hits/misses, tokens, and cost. Does not clear the cache itself.
	 *
	 * @returns void
	 * @example
	 * ```typescript
	 * embeddingService.resetStats();
	 * ```
	 */

	public resetStats(): void {
		this.totalEmbeddings = 0;
		this.cacheHits = 0;
		this.cacheMisses = 0;
		this.totalTokens = 0;
		this.totalCost = 0;
		logger.info('Embedding statistics reset');
	}

	/**
	 * Clears the LRU embedding cache and resets cache hit/miss counters.
	 *
	 * @example
	 * ```typescript
	 * embeddingService.clearCache();
	 * ```
	 */
	public clearCache(): void {
		const previousSize = this.cache.size;
		this.cache.clear();
		this.cacheHits = 0;
		this.cacheMisses = 0;
		logger.info(`Cache cleared: ${previousSize} entries removed`);
	}

	/**
	 * Validates an embedding vector against expected dimensions and numeric constraints.
	 *
	 * @param embedding - The vector to validate.
	 * @param variant - Which model's dimensions to validate against: `'small'` (default, 384d) or `'large'` (3072d).
	 * @returns boolean - `true` if the embedding is valid, `false` otherwise. Invalid embeddings are logged.
	 * @example
	 * ```typescript
	 * const isValid = embeddingService.validateEmbedding([0.1, 0.2, ...], 'small');
	 * ```
	 */

	public validateEmbedding(embedding: number[], variant: 'small' | 'large' = 'small'): boolean {
		if (!Array.isArray(embedding)) {
			return false;
		}

		const expectedDims = variant === 'large' ? this.LARGE_DIMENSIONS : this.SMALL_DIMENSIONS;
		if (embedding.length !== expectedDims) {
			logger.warn(
				`Invalid embedding dimensions: expected ${expectedDims} (${variant}), got ${embedding.length}`,
			);
			return false;
		}

		if (!embedding.every((n) => typeof n === 'number' && !isNaN(n))) {
			logger.warn('Invalid embedding values: contains non-numeric or NaN values');
			return false;
		}

		return true;
	}

	/**
	 * Estimates token count for a text using a simple heuristic (text length / 4).
	 *
	 * @param text - The text to estimate tokens for.
	 * @returns number - Approximate token count (not guaranteed to match OpenAI's tokenizer).
	 * @example
	 * ```typescript
	 * const tokens = embeddingService.estimateTokens('Hello world');
	 * console.log(tokens); // ~3
	 * ```
	 */

	public estimateTokens(text: string): number {
		return Math.ceil(text.length / CHARS_PER_TOKEN);
	}

	/**
	 * Estimates the cost in USD to embed a text using text-embedding-3-small pricing.
	 *
	 * Cost = (estimated_tokens / 1,000,000) * $0.02.
	 *
	 * @param text - The text to estimate cost for.
	 * @returns number - Estimated cost in USD (not guaranteed to match actual OpenAI billing).
	 * @example
	 * ```typescript
	 * const cost = embeddingService.estimateCost('Hello world');
	 * console.log(`Estimated cost: $${cost.toFixed(6)}`);
	 * ```
	 */

	public estimateCost(text: string): number {
		const tokens = this.estimateTokens(text);
		return (tokens / TOKENS_PER_MILLION) * COST_PER_MILLION_TOKENS_SMALL;
	}

	/**
	 * Splits text into overlapping chunks of a specified size.
	 *
	 * @param text - The text to chunk.
	 * @param chunkSize - Character threshold for chunk size (default from config.memory.chunkSize).
	 * @param overlap - Character overlap between adjacent chunks (default from config.memory.chunkOverlap).
	 * @returns Array of text chunks.
	 * @throws {Error} If `overlap >= chunkSize`, which would cause an infinite loop.
	 * @example
	 * ```typescript
	 * const chunks = embeddingService.chunkText('Long text...', 1000, 200);
	 * console.log(chunks.length); // Multiple chunks
	 * ```
	 */
	public chunkText(
		text: string,
		chunkSize: number = config.memory.chunkSize,
		overlap: number = config.memory.chunkOverlap,
	): string[] {
		if (overlap >= chunkSize) {
			throw new Error(
				`chunkOverlap (${overlap}) must be less than chunkSize (${chunkSize}) to avoid an infinite loop`,
			);
		}

		if (text.length <= chunkSize) {
			return [text];
		}

		const chunks: string[] = [];
		let start = 0;

		while (start < text.length) {
			const end = Math.min(start + chunkSize, text.length);
			chunks.push(text.slice(start, end));
			start += chunkSize - overlap;
		}

		logger.debug(`Chunked text into ${chunks.length} pieces`);
		return chunks;
	}

	/**
	 * Chunks a single text and generates embeddings for all chunks.
	 *
	 * Splits the text using the specified chunk size and overlap, then generates embeddings for each chunk using batch processing.
	 *
	 * @param text - The text to chunk and embed.
	 * @param chunkSize - Character threshold for chunk size (default from config.memory.chunkSize).
	 * @param overlap - Character overlap between adjacent chunks (default from config.memory.chunkOverlap).
	 * @returns Array of objects, each with `chunk` (text), `embedding` (vector), `index` (chunk number), and `total` (total chunks).
	 * @throws {Error} If chunking fails (e.g., overlap >= chunkSize), or if OpenAI API calls fail after all retry attempts are exhausted.
	 * @example
	 * ```typescript
	 * const chunks = await embeddingService.generateChunkedEmbeddings(
	 *   'Very long text...',
	 *   1000,  // chunkSize
	 *   200    // overlap
	 * );
	 * console.log(`${chunks.length} chunks embedded`);
	 * ```
	 */

	public async generateChunkedEmbeddings(
		text: string,
		chunkSize?: number,
		overlap?: number,
	): Promise<
		Array<{
			chunk: string;
			embedding: number[];
			index: number;
			total: number;
		}>
	> {
		const chunks = this.chunkText(text, chunkSize, overlap);
		const embeddings = await this.generateBatchEmbeddings(chunks);

		return chunks.map((chunk, index) => ({
			chunk,
			embedding: embeddings[index],
			index,
			total: chunks.length,
		}));
	}

	// ── Private helpers ────────────────────────────────────────────────────────

	private async generateOpenAIEmbedding(
		text: string,
		model: string,
		dimensions: number,
	): Promise<number[]> {
		const isLarge = model === LARGE_MODEL;

		const result = await withRetry(
			() => this.client.embeddings.create({ model, input: text, dimensions }),
			{
				maxRetries: 3,
				initialDelay: 1000,
				retryableStatusCodes: [
					HTTP_STATUS_TOO_MANY_REQUESTS,
					HTTP_STATUS_INTERNAL_SERVER_ERROR,
					HTTP_STATUS_BAD_GATEWAY,
					HTTP_STATUS_SERVICE_UNAVAILABLE,
					HTTP_STATUS_GATEWAY_TIMEOUT,
				],
			},
		);

		const [{ embedding }] = result.data;
		const tokens = result.usage.total_tokens;
		const costPerM = isLarge
			? COST_PER_MILLION_TOKENS_LARGE
			: COST_PER_MILLION_TOKENS_SMALL;

		// Validate embedding before returning
		const variant = isLarge ? 'large' : 'small';
		if (!this.validateEmbedding(embedding, variant)) {
			throw new Error(`Invalid embedding received from OpenAI: expected ${dimensions}d ${variant} embedding`);
		}

		this.totalTokens += tokens;
		this.totalCost += (tokens / TOKENS_PER_MILLION) * costPerM;

		logger.debug(
			`OpenAI embedding: ${embedding.length}d, ${tokens} tokens, $${(
				(tokens / TOKENS_PER_MILLION) * costPerM
			).toFixed(COST_LOG_PRECISION)}`,
		);

		return embedding;
	}

	/**
	 * Generate embeddings for a batch of texts using a single OpenAI API call.
	 * Checks the LRU cache first; only uncached texts are sent to the API.
	 *
	 * @param texts   - Array of texts to embed.
	 * @param model   - Model identifier.
	 * @param dims    - Output dimensions.
	 * @param variant - Cache key variant ('small' | 'large').
	 * @returns Array of embedding vectors in the same order as `texts`.
	 */
	private async generateOpenAIBatch(
		texts: string[],
		model: string,
		dims: number,
		variant: 'small' | 'large',
	): Promise<number[][]> {
		const results: (number[] | null)[] = new Array(texts.length).fill(null);
		const uncachedIndices: number[] = [];

		for (let i = 0; i < texts.length; i++) {
			const key = this.getCacheKey(texts[i], variant);
			const cached = this.cache.get(key);
			if (cached) {
				this.cacheHits++;
				this.cache.delete(key);
				cached.hits++;
				cached.timestamp = Date.now();
				this.cache.set(key, cached);
				results[i] = cached.embedding;
			} else {
				this.cacheMisses++;
				uncachedIndices.push(i);
			}
		}

		if (uncachedIndices.length > 0) {
			const uncachedTexts = uncachedIndices.map(i => texts[i]);
			const isLarge = model === LARGE_MODEL;

			const response = await withRetry(
				() => this.client.embeddings.create({ model, input: uncachedTexts, dimensions: dims }),
				{
					maxRetries: 3,
					initialDelay: 1000,
					retryableStatusCodes: [
						HTTP_STATUS_TOO_MANY_REQUESTS,
						HTTP_STATUS_INTERNAL_SERVER_ERROR,
						HTTP_STATUS_BAD_GATEWAY,
						HTTP_STATUS_SERVICE_UNAVAILABLE,
						HTTP_STATUS_GATEWAY_TIMEOUT,
					],
				},
			);

			const tokens = response.usage.total_tokens;
			const costPerM = isLarge ? COST_PER_MILLION_TOKENS_LARGE : COST_PER_MILLION_TOKENS_SMALL;
			this.totalTokens += tokens;
			this.totalCost += (tokens / TOKENS_PER_MILLION) * costPerM;

			response.data.forEach((item, idx) => {
				const originalIdx = uncachedIndices[idx];
				const key = this.getCacheKey(texts[originalIdx], variant);
				this.addToCache(key, item.embedding);
				results[originalIdx] = item.embedding;
			});

			logger.debug(
				`OpenAI batch embedding: ${uncachedTexts.length} texts, ${tokens} tokens, $${((tokens / TOKENS_PER_MILLION) * costPerM).toFixed(COST_LOG_PRECISION)}`,
			);
		}

		// Type guard: ensure all results are populated (cache hit or API response)
		const typedResults = results.filter((r): r is number[] => r !== null);
		if (typedResults.length !== results.length) {
			throw new Error(`Embedding generation failed: ${results.length - typedResults.length} entries remain null`);
		}
		return typedResults;
	}

	private getCacheKey(text: string, variant: 'small' | 'large'): string {
		const hash = createHash('sha256');
		const model = variant === 'large' ? LARGE_MODEL : SMALL_MODEL;
		const dims = variant === 'large' ? this.LARGE_DIMENSIONS : this.SMALL_DIMENSIONS;
		hash.update(model);
		hash.update(String(dims));
		hash.update(text);
		return hash.digest('hex');
	}

	private addToCache(key: string, embedding: number[]): void {
		if (this.cache.size >= this.maxCacheSize) {
			this.evictLRU();
		}

		this.cache.set(key, {
			embedding,
			timestamp: Date.now(),
			hits: 0,
		});
	}

	private evictLRU(): void {
		// JavaScript's Map preserves insertion order.  Cache hits promote entries to
		// the end via delete+re-insert (see generateEmbedding / generateLargeEmbedding),
		// so the first key is always the least-recently-used entry — O(1) eviction.
		const firstKey = this.cache.keys().next().value;
		if (firstKey !== undefined) {
			this.cache.delete(firstKey);
			logger.debug('Evicted LRU cache entry');
		}
	}

	private truncate(text: string, maxLength: number): string {
		return text.length <= maxLength ? text : text.slice(0, maxLength) + '...';
	}
}

/**
 * Singleton embedding service instance for the entire application.
 *
 * @example
 * ```typescript
 * import { embeddingService } from './services/embedding-service.js';
 * const embedding = await embeddingService.generateEmbedding('Hello, world!');
 * const largeEmbedding = await embeddingService.generateLargeEmbedding('Longer text here');
 * const stats = embeddingService.getStats();
 * console.log(`Cache hit rate: ${(stats.cacheHitRate * 100).toFixed(1)}%`);
 * ```
 */
export const embeddingService = new EmbeddingService();
