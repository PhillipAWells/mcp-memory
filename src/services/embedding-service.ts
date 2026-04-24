/**
 * Embedding Service
 *
 * Generates embeddings using OpenAI text-embedding-3-small / text-embedding-3-large,
 * with LRU caching and cost tracking.
 */

import OpenAI from 'openai';
import { createHash } from 'crypto';
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

	private readonly SMALL_MODEL = 'text-embedding-3-small';
	private readonly LARGE_MODEL = 'text-embedding-3-large';
	private readonly SMALL_DIMENSIONS: number;
	private readonly LARGE_DIMENSIONS: number;

	// Usage statistics
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
		logger.info(`Embedding service initialized (model: ${this.SMALL_MODEL})`);
		logger.debug(`Max cache size: ${this.maxCacheSize}`);
	}

	/**
   * Generate embedding for a single text (primary / small)
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

		const embedding = await this.generateOpenAIEmbedding(text, this.SMALL_MODEL, this.SMALL_DIMENSIONS);

		this.addToCache(cacheKey, embedding);
		return embedding;
	}

	/**
   * Generate large embedding for a single text using text-embedding-3-large.
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

		const embedding = await this.generateOpenAIEmbedding(text, this.LARGE_MODEL, this.LARGE_DIMENSIONS);

		this.addToCache(cacheKey, embedding);
		return embedding;
	}

	/**
   * Generate both small and large embeddings in parallel.
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
   * Generate embeddings for multiple texts (batch)
   */
	public async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
		logger.info(`Generating batch embeddings: ${texts.length} texts`);

		const embeddings: number[][] = [];
		for (let i = 0; i < texts.length; i += BATCH_SIZE) {
			const batch = texts.slice(i, i + BATCH_SIZE);
			const batchResults = await this.generateOpenAIBatch(
				batch,
				this.SMALL_MODEL,
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
   * Get usage statistics
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
   * Get cache statistics
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
   * Reset statistics
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
   * Clear cache
   */
	public clearCache(): void {
		const previousSize = this.cache.size;
		this.cache.clear();
		this.cacheHits = 0;
		this.cacheMisses = 0;
		logger.info(`Cache cleared: ${previousSize} entries removed`);
	}

	/**
   * Validate embedding dimensions.
   *
   * @param embedding - The vector to validate.
   * @param variant   - Which named vector to check against: `'small'` (default)
   *                    or `'large'`. Determines the expected dimension count.
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
   * Estimate tokens for text (approximate)
   */
	public estimateTokens(text: string): number {
		return Math.ceil(text.length / CHARS_PER_TOKEN);
	}

	/**
   * Estimate cost for text (based on text-embedding-3-small pricing).
   */
	public estimateCost(text: string): number {
		const tokens = this.estimateTokens(text);
		return (tokens / TOKENS_PER_MILLION) * COST_PER_MILLION_TOKENS_SMALL;
	}

	/**
   * Chunk text into smaller pieces for embedding
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
   * Generate embeddings for chunked text
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
		const isLarge = model === this.LARGE_MODEL;

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
			const isLarge = model === this.LARGE_MODEL;

			// Count actual embedding requests (cache misses)
			this.totalEmbeddings += uncachedIndices.length;

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
		const model = variant === 'large' ? this.LARGE_MODEL : this.SMALL_MODEL;
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

// Export singleton instance
export const embeddingService = new EmbeddingService();
