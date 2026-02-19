/**
 * Embedding Service
 *
 * Generates embeddings with LRU caching and cost tracking.
 * Supports two providers:
 *   - 'openai'  — OpenAI text-embedding-3-small / text-embedding-3-large (requires OPENAI_API_KEY)
 *   - 'local'   — @huggingface/transformers running locally (no API key required)
 */

import OpenAI from 'openai';
import { createHash } from 'crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { generateLocalEmbedding } from './local-embedding-provider.js';
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
 * Generates embeddings with caching and cost tracking.
 * Provider (openai | local) is determined by config.embedding.provider.
 */
export class EmbeddingService {
  private readonly client: OpenAI | null;
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

    if (config.embedding.provider === 'openai') {
      if (!config.openai.apiKey) {
        throw new Error(
          'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai. ' +
          'Set the key or omit EMBEDDING_PROVIDER to use local embeddings.',
        );
      }
      this.client = new OpenAI({ apiKey: config.openai.apiKey });
      logger.info(`Embedding service initialized (provider: openai, model: ${this.SMALL_MODEL})`);
    } else {
      this.client = null;
      logger.info(
        `Embedding service initialized (provider: local, model: ${config.embedding.localModel}, ` +
        `dimensions: ${this.SMALL_DIMENSIONS})`,
      );
    }

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

    const embedding = config.embedding.provider === 'openai'
      ? await this.generateOpenAIEmbedding(text, this.SMALL_MODEL, this.SMALL_DIMENSIONS)
      : await generateLocalEmbedding(text);

    this.addToCache(cacheKey, embedding);
    return embedding;
  }

  /**
   * Generate large embedding for a single text.
   * With OpenAI: uses text-embedding-3-large (higher quality).
   * With local provider: uses the same local model (no quality distinction).
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

    const embedding = config.embedding.provider === 'openai'
      ? await this.generateOpenAIEmbedding(text, this.LARGE_MODEL, this.LARGE_DIMENSIONS)
      : await generateLocalEmbedding(text);

    this.addToCache(cacheKey, embedding);
    return embedding;
  }

  /**
   * Generate both small and large embeddings.
   * With OpenAI: two separate API calls (different quality models) in parallel.
   * With local provider: single inference, result reused for both vectors.
   */
  public async generateDualEmbeddings(text: string): Promise<{
    small: number[];
    large: number[];
  }> {
    if (config.embedding.provider === 'local') {
      // Local: one model, one inference — reuse for both named vectors
      const embedding = await this.generateEmbedding(text);
      logger.debug('Dual embeddings generated (local, single inference)');
      return { small: embedding, large: embedding };
    }

    // OpenAI: generate both in parallel
    const [small, large] = await Promise.all([
      this.generateEmbedding(text),
      this.generateLargeEmbedding(text),
    ]);
    logger.debug('Dual embeddings generated (openai, parallel)');
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
      const batchResults = await Promise.all(
        batch.map((text) => this.generateEmbedding(text)),
      );
      embeddings.push(...batchResults);

      logger.debug(
        `Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(
          texts.length / BATCH_SIZE,
        )} completed`,
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
    logger.info(`Cache cleared: ${previousSize} entries removed`);
  }

  /**
   * Validate embedding dimensions
   */
  public validateEmbedding(embedding: number[]): boolean {
    if (!Array.isArray(embedding)) {
      return false;
    }

    if (embedding.length !== this.SMALL_DIMENSIONS) {
      logger.warn(
        `Invalid embedding dimensions: expected ${this.SMALL_DIMENSIONS}, got ${embedding.length}`,
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
   * Estimate cost for text.
   * Returns 0 for local provider (no API cost).
   */
  public estimateCost(text: string): number {
    if (config.embedding.provider === 'local') return 0;
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

    if (!this.client) {
      throw new Error('OpenAI client is not initialized');
    }
    // eslint-disable-next-line prefer-destructuring -- needed for type narrowing after null guard
    const client = this.client;

    const result = await withRetry(
      () => client.embeddings.create({ model, input: text, dimensions }),
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

    this.totalTokens += tokens;
    this.totalCost += (tokens / TOKENS_PER_MILLION) * costPerM;

    logger.debug(
      `OpenAI embedding: ${embedding.length}d, ${tokens} tokens, $${(
        (tokens / TOKENS_PER_MILLION) * costPerM
      ).toFixed(COST_LOG_PRECISION)}`,
    );

    return embedding;
  }

  private getCacheKey(text: string, variant: 'small' | 'large'): string {
    const hash = createHash('sha256');
    const model = config.embedding.provider === 'openai'
      ? (variant === 'large' ? this.LARGE_MODEL : this.SMALL_MODEL)
      : config.embedding.localModel;
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
