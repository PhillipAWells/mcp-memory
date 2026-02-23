/**
 * Tests for EmbeddingService
 *
 * All tests use the 'local' provider (no OpenAI key required) with mocked
 * generateLocalEmbedding so that no model download occurs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock local embedding provider ────────────────────────────────────────────
// Must be hoisted before the service import so the module resolution picks it up.
vi.mock('../local-embedding-provider.js', () => ({
	generateLocalEmbedding: vi.fn((_text: string) => new Array(384).fill(0.1)),
	preloadLocalPipeline: vi.fn(() => undefined),
	resetLocalPipeline: vi.fn(),
}));

// ── Mock config ───────────────────────────────────────────────────────────────
vi.mock('../../config.js', () => ({
	config: {
		embedding: {
			provider: 'local',
			localModel: 'test-model',
			smallDimensions: 384,
			largeDimensions: 384,
		},
		openai: { apiKey: undefined },
		server: { logLevel: 'error' },
		memory: { chunkSize: 1000, chunkOverlap: 200 },
	},
}));

import { EmbeddingService } from '../embedding-service.js';
import { generateLocalEmbedding } from '../local-embedding-provider.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeService(): EmbeddingService {
	return new EmbeddingService();
}

// ── generateEmbedding ─────────────────────────────────────────────────────────

describe('EmbeddingService.generateEmbedding', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		vi.clearAllMocks();
		service = makeService();
	});

	it('returns an embedding vector for new text', async () => {
		const result = await service.generateEmbedding('hello world');
		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(384);
	});

	it('calls the local provider exactly once on a cache miss', async () => {
		await service.generateEmbedding('unique text abc');
		expect(generateLocalEmbedding).toHaveBeenCalledTimes(1);
	});

	it('returns cached result on second call (cache hit)', async () => {
		const text = 'cached text';
		const first = await service.generateEmbedding(text);
		const second = await service.generateEmbedding(text);
		expect(second).toEqual(first);
		// Provider called only once — second comes from cache
		expect(generateLocalEmbedding).toHaveBeenCalledTimes(1);
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
		service = makeService();
	});

	it('returns an embedding vector', async () => {
		const result = await service.generateLargeEmbedding('large text');
		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(384);
	});

	it('shares cache key with small embedding when model+dims are equal (local provider)', async () => {
		// With local provider both 'small' and 'large' use the same model and dimensions,
		// so getCacheKey() produces the same hash → second call is a cache hit.
		const text = 'same text';
		await service.generateEmbedding(text);
		await service.generateLargeEmbedding(text); // cache hit — same key
		expect(generateLocalEmbedding).toHaveBeenCalledTimes(1);
	});

	it('caches large embedding separately', async () => {
		const text = 'large cache test';
		await service.generateLargeEmbedding(text);
		await service.generateLargeEmbedding(text);
		// Second call is a cache hit
		expect(generateLocalEmbedding).toHaveBeenCalledTimes(1);
	});
});

// ── generateDualEmbeddings ────────────────────────────────────────────────────

describe('EmbeddingService.generateDualEmbeddings', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		vi.clearAllMocks();
		service = makeService();
	});

	it('returns both small and large vectors', async () => {
		const result = await service.generateDualEmbeddings('dual text');
		expect(result.small).toHaveLength(384);
		expect(result.large).toHaveLength(384);
	});

	it('uses a single local inference call (provider=local reuses small embedding)', async () => {
		await service.generateDualEmbeddings('dual text');
		// Local provider uses same model for small and large; generateEmbedding is
		// called once and the result is reused for 'large'
		expect(generateLocalEmbedding).toHaveBeenCalledTimes(1);
	});
});

// ── LRU eviction ──────────────────────────────────────────────────────────────

describe('EmbeddingService LRU cache eviction', () => {
	it('evicts the least-recently-used entry when cache is full', async () => {
		// Build a service with a tiny cache (size 2) by overriding the private field
		const service = makeService();
		(service as any).maxCacheSize = 2;

		vi.clearAllMocks();

		const mockEmbed = vi.mocked(generateLocalEmbedding);

		await service.generateEmbedding('text-1'); // miss, cached
		await service.generateEmbedding('text-2'); // miss, cached
		// Access text-1 to make it recently used; text-2 is now LRU
		await service.generateEmbedding('text-1'); // hit

		// Add text-3 — cache is full (size 2), so text-2 (LRU) is evicted
		await service.generateEmbedding('text-3'); // miss, evicts text-2

		// text-2 should have been evicted — fetching it is another miss
		const callsBefore = mockEmbed.mock.calls.length;
		await service.generateEmbedding('text-2');
		expect(mockEmbed.mock.calls.length).toBe(callsBefore + 1);
	});
});

// ── chunkText ─────────────────────────────────────────────────────────────────

describe('EmbeddingService.chunkText', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		service = makeService(); 
	});

	it('returns the original text as a single chunk when short enough', () => {
		const text = 'short text';
		const chunks = service.chunkText(text, 100, 10);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toBe(text);
	});

	it('splits long text into overlapping chunks', () => {
		const text = 'a'.repeat(300);
		const chunks = service.chunkText(text, 100, 20);
		// Each chunk is at most 100 chars
		for (const c of chunks) {
			expect(c.length).toBeLessThanOrEqual(100);
		}
		expect(chunks.length).toBeGreaterThan(1);
	});

	it('each chunk overlaps with the next by the specified overlap amount', () => {
		const text = 'abcdefghijklmnopqrstuvwxyz'; // 26 chars
		const chunks = service.chunkText(text, 10, 5);
		// chunk[0] = text[0..9], chunk[1] = text[5..14], overlap = text[5..9]
		expect(chunks[0].slice(5)).toBe(chunks[1].slice(0, 5));
	});
});

// ── validateEmbedding ─────────────────────────────────────────────────────────

describe('EmbeddingService.validateEmbedding', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		service = makeService(); 
	});

	it('returns true for a valid 384-dim embedding', () => {
		expect(service.validateEmbedding(new Array(384).fill(0.5))).toBe(true);
	});

	it('returns false for wrong dimension', () => {
		expect(service.validateEmbedding(new Array(128).fill(0.5))).toBe(false);
	});

	it('returns false for non-array', () => {
		expect(service.validateEmbedding('not an array' as any)).toBe(false);
	});

	it('returns false when embedding contains NaN', () => {
		const vec = new Array(384).fill(0.5);
		vec[10] = NaN;
		expect(service.validateEmbedding(vec)).toBe(false);
	});
});

// ── estimateTokens / estimateCost ─────────────────────────────────────────────

describe('EmbeddingService.estimateTokens', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		service = makeService(); 
	});

	it('estimates tokens as ceil(chars / 4)', () => {
		expect(service.estimateTokens('abcd')).toBe(1);    // 4 chars → 1 token
		expect(service.estimateTokens('abcde')).toBe(2);   // 5 chars → 2 tokens
	});
});

describe('EmbeddingService.estimateCost', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		service = makeService(); 
	});

	it('returns 0 for local provider', () => {
		expect(service.estimateCost('some text')).toBe(0);
	});
});

// ── getStats / resetStats ─────────────────────────────────────────────────────

describe('EmbeddingService stats', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		vi.clearAllMocks();
		service = makeService();
	});

	it('starts with all-zero stats', () => {
		const stats = service.getStats();
		expect(stats.totalEmbeddings).toBe(0);
		expect(stats.cacheHits).toBe(0);
		expect(stats.cacheMisses).toBe(0);
		expect(stats.cacheHitRate).toBe(0);
	});

	it('cacheHitRate is 0 when no embeddings have been generated', () => {
		expect(service.getStats().cacheHitRate).toBe(0);
	});

	it('resetStats zeroes all counters', async () => {
		await service.generateEmbedding('reset test');
		service.resetStats();
		const stats = service.getStats();
		expect(stats.totalEmbeddings).toBe(0);
		expect(stats.cacheMisses).toBe(0);
	});
});
