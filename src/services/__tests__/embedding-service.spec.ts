/**
 * Tests for EmbeddingService (OpenAI provider)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock OpenAI ───────────────────────────────────────────────────────────────

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('openai', () => {
	class MockOpenAI {
		embeddings = { create: mockCreate };
	}
	return {
		default: MockOpenAI,
	};
});

// ── Mock config ───────────────────────────────────────────────────────────────
vi.mock('../../config.js', () => ({
	config: {
		embedding: {
			smallDimensions: 1536,
			largeDimensions: 3072,
		},
		openai: { apiKey: 'test-key' },
		server: { logLevel: 'error' },
		memory: { chunkSize: 1000, chunkOverlap: 200 },
	},
}));

import { EmbeddingService } from '../embedding-service.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSmallResponse(dims = 1536) {
	return {
		data: [{ embedding: new Array(dims).fill(0.1) }],
		usage: { total_tokens: 10 },
	};
}

function makeLargeResponse(dims = 3072) {
	return {
		data: [{ embedding: new Array(dims).fill(0.2) }],
		usage: { total_tokens: 10 },
	};
}

function makeService(): EmbeddingService {
	return new EmbeddingService();
}

// ── generateEmbedding ─────────────────────────────────────────────────────────

describe('EmbeddingService.generateEmbedding', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		vi.clearAllMocks();
		mockCreate.mockResolvedValue(makeSmallResponse());
		service = makeService();
	});

	it('returns an embedding vector for new text', async () => {
		const result = await service.generateEmbedding('hello world');
		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(1536);
	});

	it('calls OpenAI exactly once on a cache miss', async () => {
		await service.generateEmbedding('unique text abc');
		expect(mockCreate).toHaveBeenCalledTimes(1);
	});

	it('returns cached result on second call (cache hit)', async () => {
		const text = 'cached text';
		const first = await service.generateEmbedding(text);
		const second = await service.generateEmbedding(text);
		expect(second).toEqual(first);
		expect(mockCreate).toHaveBeenCalledTimes(1);
	});

	it('increments cacheHits stat on cache hit', async () => {
		const text = 'stat text';
		await service.generateEmbedding(text);
		await service.generateEmbedding(text);
		const stats = service.getStats();
		expect(stats.cacheHits).toBe(1);
		expect(stats.cacheMisses).toBe(1);
	});

	it('increments cacheHits accurately for multiple different texts', async () => {
		await service.generateEmbedding('text a');
		await service.generateEmbedding('text b');
		await service.generateEmbedding('text a'); // cache hit
		const stats = service.getStats();
		expect(stats.totalEmbeddings).toBe(3);
		expect(stats.cacheHits).toBe(1);
		expect(stats.cacheMisses).toBe(2);
	});
});

// ── generateLargeEmbedding ────────────────────────────────────────────────────

describe('EmbeddingService.generateLargeEmbedding', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		vi.clearAllMocks();
		mockCreate.mockResolvedValue(makeLargeResponse());
		service = makeService();
	});

	it('returns an embedding vector with large dimensions', async () => {
		const result = await service.generateLargeEmbedding('large text');
		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(3072);
	});

	it('caches large embedding separately from small', async () => {
		await service.generateLargeEmbedding('large cache test');
		await service.generateLargeEmbedding('large cache test');
		expect(mockCreate).toHaveBeenCalledTimes(1);
	});

	it('uses a separate cache key from small embedding', async () => {
		mockCreate
			.mockResolvedValueOnce(makeSmallResponse())
			.mockResolvedValueOnce(makeLargeResponse());

		const text = 'same text';
		await service.generateEmbedding(text);
		await service.generateLargeEmbedding(text); // different key — not a hit
		expect(mockCreate).toHaveBeenCalledTimes(2);
	});
});

// ── generateDualEmbeddings ────────────────────────────────────────────────────

describe('EmbeddingService.generateDualEmbeddings', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		vi.clearAllMocks();
		mockCreate
			.mockResolvedValueOnce(makeSmallResponse())
			.mockResolvedValueOnce(makeLargeResponse());
		service = makeService();
	});

	it('returns both small and large vectors', async () => {
		const result = await service.generateDualEmbeddings('dual text');
		expect(result.small).toHaveLength(1536);
		expect(result.large).toHaveLength(3072);
	});

	it('makes two parallel OpenAI calls', async () => {
		await service.generateDualEmbeddings('dual text');
		expect(mockCreate).toHaveBeenCalledTimes(2);
	});
});

// ── LRU eviction ──────────────────────────────────────────────────────────────

describe('EmbeddingService LRU cache eviction', () => {
	it('evicts the least-recently-used entry when cache is full', async () => {
		mockCreate.mockResolvedValue(makeSmallResponse());
		const service = makeService();
		(service as any).maxCacheSize = 2;

		vi.clearAllMocks();

		await service.generateEmbedding('text-1'); // miss, cached
		await service.generateEmbedding('text-2'); // miss, cached
		// Promote text-1 to MRU; text-2 is now LRU
		await service.generateEmbedding('text-1'); // hit

		// Add text-3 — evicts text-2 (LRU)
		await service.generateEmbedding('text-3'); // miss, evicts text-2

		// text-2 was evicted — fetching it is another miss
		const callsBefore = mockCreate.mock.calls.length;
		await service.generateEmbedding('text-2');
		expect(mockCreate.mock.calls.length).toBe(callsBefore + 1);
	});
});

// ── chunkText ─────────────────────────────────────────────────────────────────

describe('EmbeddingService.chunkText', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		mockCreate.mockResolvedValue(makeSmallResponse());
		service = makeService();
	});

	it('returns the original text as a single chunk when short enough', () => {
		expect(service.chunkText('short text', 100, 10)).toHaveLength(1);
	});

	it('splits long text into overlapping chunks', () => {
		const chunks = service.chunkText('a'.repeat(300), 100, 20);
		for (const c of chunks) {
			expect(c.length).toBeLessThanOrEqual(100);
		}
		expect(chunks.length).toBeGreaterThan(1);
	});

	it('each chunk overlaps with the next by the specified overlap amount', () => {
		const chunks = service.chunkText('abcdefghijklmnopqrstuvwxyz', 10, 5);
		expect(chunks[0].slice(5)).toBe(chunks[1].slice(0, 5));
	});

	it('throws when overlap equals chunk size', () => {
		expect(() => service.chunkText('a'.repeat(200), 100, 100)).toThrow(/chunkOverlap/);
	});

	it('throws when overlap exceeds chunk size', () => {
		expect(() => service.chunkText('a'.repeat(200), 50, 100)).toThrow(/chunkOverlap/);
	});
});

// ── validateEmbedding ─────────────────────────────────────────────────────────

describe('EmbeddingService.validateEmbedding', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		mockCreate.mockResolvedValue(makeSmallResponse());
		service = makeService();
	});

	it('returns true for a valid 1536-dim small embedding', () => {
		expect(service.validateEmbedding(new Array(1536).fill(0.5))).toBe(true);
	});

	it('returns false for wrong dimension', () => {
		expect(service.validateEmbedding(new Array(128).fill(0.5))).toBe(false);
	});

	it('returns false for non-array', () => {
		expect(service.validateEmbedding('not an array' as any)).toBe(false);
	});

	it('returns false when embedding contains NaN', () => {
		const vec = new Array(1536).fill(0.5);
		vec[10] = NaN;
		expect(service.validateEmbedding(vec)).toBe(false);
	});

	it('returns true for a valid 3072-dim large embedding', () => {
		expect(service.validateEmbedding(new Array(3072).fill(0.5), 'large')).toBe(true);
	});

	it('returns false for wrong large dimension', () => {
		expect(service.validateEmbedding(new Array(384).fill(0.5), 'large')).toBe(false);
	});
});

// ── estimateTokens / estimateCost ─────────────────────────────────────────────

describe('EmbeddingService.estimateTokens', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		mockCreate.mockResolvedValue(makeSmallResponse());
		service = makeService();
	});

	it('estimates tokens as ceil(chars / 4)', () => {
		expect(service.estimateTokens('abcd')).toBe(1);
		expect(service.estimateTokens('abcde')).toBe(2);
	});
});

describe('EmbeddingService.estimateCost', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		mockCreate.mockResolvedValue(makeSmallResponse());
		service = makeService();
	});

	it('returns a positive cost for non-empty text', () => {
		expect(service.estimateCost('some text')).toBeGreaterThan(0);
	});
});

// ── getStats / resetStats ─────────────────────────────────────────────────────

describe('EmbeddingService stats', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		vi.clearAllMocks();
		mockCreate.mockResolvedValue(makeSmallResponse());
		service = makeService();
	});

	it('starts with all-zero stats', () => {
		const stats = service.getStats();
		expect(stats.totalEmbeddings).toBe(0);
		expect(stats.cacheHits).toBe(0);
		expect(stats.cacheMisses).toBe(0);
		expect(stats.cacheHitRate).toBe(0);
	});

	it('resetStats zeroes all counters', async () => {
		await service.generateEmbedding('reset test');
		service.resetStats();
		const stats = service.getStats();
		expect(stats.totalEmbeddings).toBe(0);
		expect(stats.cacheMisses).toBe(0);
	});
});

// ── generateBatchEmbeddings ───────────────────────────────────────────────────

describe('EmbeddingService.generateBatchEmbeddings', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		vi.clearAllMocks();
		service = makeService();
	});

	it('returns embeddings array for batch of texts', async () => {
		mockCreate.mockResolvedValue({
			data: [
				{ embedding: new Array(1536).fill(0.1) },
				{ embedding: new Array(1536).fill(0.2) },
			],
			usage: { total_tokens: 20 },
		});

		const results = await service.generateBatchEmbeddings(['text 1', 'text 2']);
		expect(Array.isArray(results)).toBe(true);
		expect(results).toHaveLength(2);
		expect(results[0]).toHaveLength(1536);
	});

	it('increments totalEmbeddings counter for each batch item', async () => {
		mockCreate.mockResolvedValue({
			data: [
				{ embedding: new Array(1536).fill(0.1) },
				{ embedding: new Array(1536).fill(0.2) },
			],
			usage: { total_tokens: 20 },
		});

		const initialStats = service.getStats();
		await service.generateBatchEmbeddings(['text 1', 'text 2']);
		const stats = service.getStats();
		expect(stats.totalEmbeddings).toBe(initialStats.totalEmbeddings + 2);
	});

	it('counts cache hits when batch items are already cached', async () => {
		mockCreate.mockResolvedValueOnce({
			data: [
				{ embedding: new Array(1536).fill(0.1) },
				{ embedding: new Array(1536).fill(0.2) },
			],
			usage: { total_tokens: 20 },
		});

		// First: cache both texts
		await service.generateBatchEmbeddings(['text 1', 'text 2']);
		// Second: both should be cache hits
		await service.generateBatchEmbeddings(['text 1', 'text 2']);

		const stats = service.getStats();
		expect(stats.cacheHits).toBe(2);
		expect(stats.cacheMisses).toBe(2);
	});
});

// ── generateChunkedEmbeddings ─────────────────────────────────────────────────

describe('EmbeddingService.generateChunkedEmbeddings', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		vi.clearAllMocks();
		service = makeService();
	});

	it('returns array of chunks with embeddings for long content', async () => {
		mockCreate.mockImplementation(({ input }: { input: string[] }) => {
			return Promise.resolve({
				data: input.map(() => ({ embedding: new Array(1536).fill(0.1) })),
				usage: { total_tokens: 10 * input.length },
			});
		});

		// Create content longer than chunkSize (1000)
		const longContent = 'x'.repeat(2000);
		const result = await service.generateChunkedEmbeddings(longContent);

		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeGreaterThan(0);
		expect(result[0]).toHaveProperty('chunk');
		expect(result[0]).toHaveProperty('embedding');
		expect(result[0]).toHaveProperty('index');
		expect(result[0]).toHaveProperty('total');
	});

	it('increments totalEmbeddings counter for each chunk', async () => {
		mockCreate.mockImplementation(({ input }: { input: string[] }) => {
			return Promise.resolve({
				data: input.map(() => ({ embedding: new Array(1536).fill(0.1) })),
				usage: { total_tokens: 10 * input.length },
			});
		});

		const longContent = 'x'.repeat(2000);
		const initialStats = service.getStats();
		const result = await service.generateChunkedEmbeddings(longContent);
		const stats = service.getStats();

		expect(stats.totalEmbeddings).toBe(initialStats.totalEmbeddings + result.length);
	});
});

// ── clearCache ────────────────────────────────────────────────────────────────

describe('EmbeddingService.clearCache', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		vi.clearAllMocks();
		mockCreate.mockResolvedValue(makeSmallResponse());
		service = makeService();
	});

	it('clears the LRU cache', async () => {
		const text = 'cache test';
		await service.generateEmbedding(text);
		expect(mockCreate).toHaveBeenCalledTimes(1);

		service.clearCache();

		await service.generateEmbedding(text);
		expect(mockCreate).toHaveBeenCalledTimes(2);
	});

	it('resets cache hit/miss counters to zero', async () => {
		const text = 'stat test';
		await service.generateEmbedding(text);
		await service.generateEmbedding(text);

		service.clearCache();
		const stats = service.getStats();
		expect(stats.cacheHits).toBe(0);
		expect(stats.cacheMisses).toBe(0);
	});
});

// ── getCacheStats ─────────────────────────────────────────────────────────────

describe('EmbeddingService.getCacheStats', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		vi.clearAllMocks();
		mockCreate.mockResolvedValue(makeSmallResponse());
		service = makeService();
	});

	it('returns cache statistics including hit rate', async () => {
		const text = 'cache stats test';
		await service.generateEmbedding(text);
		await service.generateEmbedding(text);
		await service.generateEmbedding('other text');

		const cacheStats = service.getCacheStats();
		expect(cacheStats).toHaveProperty('size');
		expect(cacheStats).toHaveProperty('maxSize');
		expect(typeof cacheStats.size).toBe('number');
		expect(typeof cacheStats.maxSize).toBe('number');
	});

	it('reflects cache state after clearing', async () => {
		await service.generateEmbedding('text 1');
		service.clearCache();

		const stats = service.getCacheStats();
		expect(stats.size).toBe(0);
	});
});
