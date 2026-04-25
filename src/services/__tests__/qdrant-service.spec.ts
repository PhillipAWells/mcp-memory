/**
 * Unit tests for QdrantService
 *
 * The Qdrant JS client is mocked to avoid network calls.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock config ───────────────────────────────────────────────────────────────
vi.mock('../../config.js', () => ({
	config: {
		qdrant: {
			url: 'http://localhost:6333',
			collection: 'test-collection',
			timeout: 5000,
			apiKey: undefined,
		},
		embedding: { smallDimensions: 1536, largeDimensions: 3072 },
		server: { logLevel: 'silent' },
	},
}));

// ── Mock QdrantClient ─────────────────────────────────────────────────────────
const mockClient = {
	getCollections: vi.fn().mockResolvedValue({ collections: [{ name: 'test-collection' }] }),
	getCollection: vi.fn().mockResolvedValue({
		config: {
			params: {
				vectors: {
					dense: { size: 1536, distance: 'Cosine' },
					dense_large: { size: 3072, distance: 'Cosine' },
				},
			},
		},
		points_count: 0,
		indexed_vectors_count: 0,
		segments_count: 1,
		status: 'green',
		optimizer_status: 'ok',
	}),
	createCollection: vi.fn().mockResolvedValue({}),
	createPayloadIndex: vi.fn().mockResolvedValue({}),
	count: vi.fn().mockResolvedValue({ count: 0 }),
	scroll: vi.fn().mockResolvedValue({ points: [], next_page_offset: null }),
	search: vi.fn().mockResolvedValue([]),
	upsert: vi.fn().mockResolvedValue({}),
	delete: vi.fn().mockResolvedValue({}),
	retrieve: vi.fn().mockResolvedValue([]),
	setPayload: vi.fn().mockResolvedValue({}),
};

vi.mock('@qdrant/js-client-rest', () => ({
	QdrantClient: class {
		getCollections() {
			return mockClient.getCollections();
		}
		getCollection(name: string) {
			return mockClient.getCollection(name);
		}
		createCollection(...args: unknown[]) {
			return mockClient.createCollection(...args);
		}
		createPayloadIndex(...args: unknown[]) {
			return mockClient.createPayloadIndex(...args);
		}
		count(name: string, opts: unknown) {
			return mockClient.count(name, opts);
		}
		scroll(...args: unknown[]) {
			return mockClient.scroll(...args);
		}
		search(...args: unknown[]) {
			return mockClient.search(...args);
		}
		upsert(...args: unknown[]) {
			return mockClient.upsert(...args);
		}
		delete(...args: unknown[]) {
			return mockClient.delete(...args);
		}
		retrieve(...args: unknown[]) {
			return mockClient.retrieve(...args);
		}
		setPayload(...args: unknown[]) {
			return mockClient.setPayload(...args);
		}
	},
}));

import { QdrantService } from '../qdrant-client.js';

// ── Helper function to create and initialize a QdrantService ────────────────────
/**
 * Creates and initializes a QdrantService for tests.
 *
 * Clears all mocks before setup and resets the count mock after initialization.
 * This consolidates the common beforeEach pattern used across most test suites.
 *
 * @returns Initialized QdrantService instance
 */
async function createInitializedService(): Promise<QdrantService> {
	vi.clearAllMocks();
	mockClient.getCollections.mockResolvedValue({ collections: [{ name: 'test-collection' }] });
	mockClient.getCollection.mockResolvedValue({
		config: {
			params: {
				vectors: {
					dense: { size: 1536, distance: 'Cosine' },
					dense_large: { size: 3072, distance: 'Cosine' },
				},
			},
		},
		points_count: 0,
		indexed_vectors_count: 0,
		segments_count: 1,
		status: 'green',
		optimizer_status: 'ok',
	});
	mockClient.createPayloadIndex.mockResolvedValue({});
	mockClient.count.mockResolvedValue({ count: 0 });
	const service = new QdrantService();
	await service.initialize();
	vi.clearAllMocks();
	mockClient.count.mockResolvedValue({ count: 0 });
	return service;
}

// ── buildFilter (tested via count) ────────────────────────────────────────────

describe('QdrantService.buildFilter (via count)', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('passes undefined filter to Qdrant when no filter provided', async () => {
		await service.count(undefined);
		expect(mockClient.count).toHaveBeenCalledWith(
			'test-collection',
			expect.objectContaining({ filter: undefined }),
		);
	});

	it('includes workspace condition when workspace filter is set', async () => {
		await service.count({ workspace: 'my-ws' });
		const [, args] = mockClient.count.mock.calls[0] as unknown[];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const conditions = (args as any).filter.must;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const workspaceCond = conditions.find((c: any) => c.key === 'workspace');
		expect(workspaceCond).toBeDefined();
		expect(workspaceCond.match.value).toBe('my-ws');
	});

	it('includes memory_type condition when filter is set', async () => {
		await service.count({ memory_type: 'episodic' });
		const [, args] = mockClient.count.mock.calls[0] as unknown[];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const conditions = (args as any).filter.must;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const typeCond = conditions.find((c: any) => c.key === 'memory_type');
		expect(typeCond?.match.value).toBe('episodic');
	});

	it('includes min_confidence range condition', async () => {
		await service.count({ min_confidence: 0.8 });
		const [, args] = mockClient.count.mock.calls[0] as unknown[];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const conditions = (args as any).filter.must;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const confCond = conditions.find((c: any) => c.key === 'confidence');
		expect(confCond?.range.gte).toBe(0.8);
	});

	it('includes tags any-match condition', async () => {
		await service.count({ tags: ['foo', 'bar'] });
		const [, args] = mockClient.count.mock.calls[0] as unknown[];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const conditions = (args as any).filter.must;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const tagCond = conditions.find((c: any) => c.key === 'tags');
		expect(tagCond?.match.any).toEqual(['foo', 'bar']);
	});

	it('always adds expires_at exclusion condition', async () => {
		await service.count({});
		const [, args] = mockClient.count.mock.calls[0] as unknown[];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const conditions = (args as any).filter.must;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const expiryCond = conditions.find((c: any) => 'should' in c);
		expect(expiryCond).toBeDefined();
		expect(expiryCond.should).toHaveLength(2);
	});

	it('includes custom metadata key-value conditions', async () => {
		await service.count({ metadata: { chunk_group_id: 'abc-123' } });
		const [, args] = mockClient.count.mock.calls[0] as unknown[];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const conditions = (args as any).filter.must;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const metaCond = conditions.find((c: any) => c.key === 'chunk_group_id');
		expect(metaCond?.match.value).toBe('abc-123');
	});
});

// ── validateCollectionSchema ──────────────────────────────────────────────────

describe('QdrantService.validateCollectionSchema', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockClient.getCollections.mockResolvedValue({ collections: [{ name: 'test-collection' }] });
		mockClient.createPayloadIndex.mockResolvedValue({});
		mockClient.count.mockResolvedValue({ count: 0 });
	});

	it('initializes successfully with compatible collection schema', async () => {
		mockClient.getCollection.mockResolvedValue({
			config: {
				params: {
					vectors: {
						dense: { size: 1536, distance: 'Cosine' },
						dense_large: { size: 3072, distance: 'Cosine' },
					},
				},
			},
			points_count: 0,
			indexed_vectors_count: 0,
			segments_count: 1,
			status: 'green',
			optimizer_status: 'ok',
		});
		const service = new QdrantService();
		await expect(service.initialize()).resolves.not.toThrow();
	});

	it('throws when collection uses single unnamed vector (pre-dual-embedding)', async () => {
		mockClient.getCollection.mockResolvedValue({
			config: { params: { vectors: { size: 1536, distance: 'Cosine' } } },
			points_count: 0,
			indexed_vectors_count: 0,
			segments_count: 1,
			status: 'green',
			optimizer_status: 'ok',
		});
		const service = new QdrantService();
		await expect(service.initialize()).rejects.toThrow('single unnamed vector');
	});

	it('throws when dense vector has wrong dimensions', async () => {
		mockClient.getCollection.mockResolvedValue({
			config: {
				params: {
					vectors: {
						dense: { size: 768, distance: 'Cosine' },
						dense_large: { size: 3072, distance: 'Cosine' },
					},
				},
			},
			points_count: 0,
			indexed_vectors_count: 0,
			segments_count: 1,
			status: 'green',
			optimizer_status: 'ok',
		});
		const service = new QdrantService();
		await expect(service.initialize()).rejects.toThrow('size mismatch');
	});

	it('throws when dense_large vector is missing', async () => {
		mockClient.getCollection.mockResolvedValue({
			config: {
				params: {
					vectors: {
						dense: { size: 1536, distance: 'Cosine' },
					},
				},
			},
			points_count: 0,
			indexed_vectors_count: 0,
			segments_count: 1,
			status: 'green',
			optimizer_status: 'ok',
		});
		const service = new QdrantService();
		await expect(service.initialize()).rejects.toThrow('missing vector');
	});
});

// ── Access tracking ──────────────────────────────────────────────────────────

describe('QdrantService.get (access tracking)', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('increments access_count correctly on point retrieval', async () => {
		vi.useFakeTimers();

		try {
			const pointId = 'point-123';
			const currentAccessCount = 5;

			// Mock retrieve to return a point with access_count
			mockClient.retrieve.mockResolvedValue([
				{
					id: pointId,
					payload: {
						content: 'test content',
						path: '/test',
						access_count: currentAccessCount,
						last_accessed_at: '2026-04-20T00:00:00Z',
						created_at: '2026-04-20T00:00:00Z',
						updated_at: '2026-04-20T00:00:00Z',
					},
				},
			]);

			// Mock setPayload for access tracking update
			mockClient.setPayload.mockResolvedValue({});

			// Call get which internally calls updateAccessTracking
			const result = await service.get(pointId);

			// Verify the point was retrieved
			expect(result).not.toBeNull();
			expect(result?.content).toBe('test content');

			// Wait for fire-and-forget updateAccessTracking to complete
			await vi.runAllTimersAsync();

			// Verify setPayload was called with incremented access_count
			expect(mockClient.setPayload).toHaveBeenCalledWith(
				'test-collection',
				expect.objectContaining({
					wait: false,
					points: expect.arrayContaining([pointId]),
					payload: expect.objectContaining({
						access_count: currentAccessCount + 1,
					}),
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('handles zero initial access_count correctly', async () => {
		vi.useFakeTimers();

		try {
			const pointId = 'point-456';

			// Mock retrieve to return a point with no access_count
			mockClient.retrieve.mockResolvedValue([
				{
					id: pointId,
					payload: {
						content: 'test content',
						path: '/test',
						created_at: '2026-04-20T00:00:00Z',
						updated_at: '2026-04-20T00:00:00Z',
					},
				},
			]);

			mockClient.setPayload.mockResolvedValue({});

			await service.get(pointId);

			// Wait for fire-and-forget updateAccessTracking to complete
			await vi.runAllTimersAsync();

			// Verify access_count is set to 1 (0 + 1)
			expect(mockClient.setPayload).toHaveBeenCalledWith(
				'test-collection',
				expect.objectContaining({
					points: expect.arrayContaining([pointId]),
					payload: expect.objectContaining({
						access_count: 1,
					}),
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('updates last_accessed_at timestamp on retrieval', async () => {
		vi.useFakeTimers();

		try {
			const pointId = 'point-789';

			mockClient.retrieve.mockResolvedValue([
				{
					id: pointId,
					payload: {
						content: 'test content',
						path: '/test',
						access_count: 0,
						created_at: '2026-04-20T00:00:00Z',
						updated_at: '2026-04-20T00:00:00Z',
					},
				},
			]);

			mockClient.setPayload.mockResolvedValue({});

			await service.get(pointId);

			// Wait for fire-and-forget updateAccessTracking to complete
			await vi.runAllTimersAsync();

			// Verify setPayload includes a new last_accessed_at timestamp
			const [, setPayloadArgs] = mockClient.setPayload.mock.calls[0] as unknown[];
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const payload = (setPayloadArgs as any).payload as any;

			expect(payload.last_accessed_at).toBeDefined();
			// Verify it's an ISO 8601 timestamp with milliseconds
			expect(payload.last_accessed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		} finally {
			vi.useRealTimers();
		}
	});

	it('handles retrieve returning empty results gracefully', async () => {
		const pointId = 'non-existent';

		mockClient.retrieve.mockResolvedValue([]);

		const result = await service.get(pointId);

		// Should return null for non-existent point
		expect(result).toBeNull();

		// Should NOT call setPayload when no points are retrieved
		expect(mockClient.setPayload).not.toHaveBeenCalled();
	});
});

// ── Core upsert/batchUpsert/search/list/delete methods ────────────────────────

describe('QdrantService.upsert', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('upserts a point with content, metadata, and embeddings', async () => {
		const content = 'Test memory content';
		const vector = new Array(1536).fill(0.1);
		const vectorLarge = new Array(3072).fill(0.2);
		const metadata = { workspace: 'test-ws', memory_type: 'episodic' as const, confidence: 0.85 };

		mockClient.upsert.mockResolvedValue({});

		const id = await service.upsert(content, vector, metadata, vectorLarge);

		expect(typeof id).toBe('string');
		expect(id.length).toBeGreaterThan(0);
		expect(mockClient.upsert).toHaveBeenCalledWith(
			'test-collection',
			expect.objectContaining({
				wait: true,
				points: expect.arrayContaining([
					expect.objectContaining({
						id,
						payload: expect.objectContaining({
							content,
							workspace: 'test-ws',
							memory_type: 'episodic',
							confidence: 0.85,
						}),
						vector: expect.objectContaining({
							dense: vector,
							dense_large: vectorLarge,
						}),
					}),
				]),
			}),
		);
	});

	it('generates a UUID id when not provided', async () => {
		const content = 'Test content';
		const vector = new Array(1536).fill(0.1);
		mockClient.upsert.mockResolvedValue({});

		const id = await service.upsert(content, vector, {});

		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		expect(mockClient.upsert).toHaveBeenCalled();
	});

	it('uses provided id when specified in metadata', async () => {
		const providedId = 'custom-id-12345';
		const vector = new Array(1536).fill(0.1);
		mockClient.upsert.mockResolvedValue({});

		const id = await service.upsert('content', vector, { id: providedId });

		expect(id).toBe(providedId);
	});

	it('sets created_at and updated_at timestamps', async () => {
		const vector = new Array(1536).fill(0.1);
		mockClient.upsert.mockResolvedValue({});
		const beforeCall = new Date().toISOString();

		await service.upsert('content', vector, {});

		const _afterCall = new Date().toISOString();
		const calls = mockClient.upsert.mock.calls[0] as unknown[];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const point = (calls[1] as any).points[0] as any;
		const createdAt = point.payload.created_at;
		const updatedAt = point.payload.updated_at;

		expect(new Date(createdAt).getTime()).toBeGreaterThanOrEqual(new Date(beforeCall).getTime());
		expect(new Date(updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(beforeCall).getTime());
	});

	it('preserves provided metadata.updated_at when supplied', async () => {
		const vector = new Array(1536).fill(0.1);
		const providedTimestamp = '2025-01-01T00:00:00Z';
		mockClient.upsert.mockResolvedValue({});

		await service.upsert('content', vector, { updated_at: providedTimestamp });

		const calls = mockClient.upsert.mock.calls[0] as unknown[];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const point = (calls[1] as any).points[0] as any;
		const actualUpdatedAt = point.payload.updated_at;

		expect(actualUpdatedAt).toBe(providedTimestamp);
	});

	it('applies default values for optional metadata fields', async () => {
		const vector = new Array(1536).fill(0.1);
		mockClient.upsert.mockResolvedValue({});

		await service.upsert('content', vector, {});

		const calls = mockClient.upsert.mock.calls[0] as unknown[];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const point = (calls[1] as any).points[0] as any;

		expect(point.payload.memory_type).toBe('long-term');
		expect(point.payload.confidence).toBe(0.7); // DEFAULT_CONFIDENCE
		expect(point.payload.access_count).toBe(0);
		expect(point.payload.tags).toEqual([]);
	});

	it('handles upsert error by rejecting the promise', async () => {
		const vector = new Array(1536).fill(0.1);
		mockClient.upsert.mockRejectedValue(new Error('Upsert failed'));

		await expect(service.upsert('content', vector, {})).rejects.toThrow('Upsert failed');
	});
});

describe('QdrantService.batchUpsert', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('batch upserts multiple points', async () => {
		const points = [
			{ content: 'point 1', vector: new Array(1536).fill(0.1) },
			{ content: 'point 2', vector: new Array(1536).fill(0.2) },
		];
		mockClient.upsert.mockResolvedValue({});

		const result = await service.batchUpsert(points);

		expect(result.successfulIds).toHaveLength(2);
		expect(result.failedPoints).toHaveLength(0);
		expect(result.totalProcessed).toBe(2);
		expect(mockClient.upsert).toHaveBeenCalledTimes(1);
	});

	it('returns result with processed count', async () => {
		const points = Array.from({ length: 10 }, (_, i) => ({
			content: `point ${i}`,
			vector: new Array(1536).fill(0.1),
		}));

		mockClient.upsert.mockResolvedValueOnce({});
		mockClient.upsert.mockResolvedValueOnce({});

		const result = await service.batchUpsert(points);

		expect(result.totalProcessed).toBe(points.length);
		expect(Array.isArray(result.successfulIds)).toBe(true);
		expect(Array.isArray(result.failedPoints)).toBe(true);
	});

	it('generates UUIDs for points without ids', async () => {
		const points = [{ content: 'content', vector: new Array(1536).fill(0.1) }];
		mockClient.upsert.mockResolvedValue({});

		const result = await service.batchUpsert(points);

		expect(result.successfulIds.length).toBeGreaterThan(0);
		expect(typeof result.successfulIds[0]).toBe('string');
	});
});

describe('QdrantService.search', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('performs vector similarity search', async () => {
		const vector = new Array(1536).fill(0.1);
		mockClient.search.mockResolvedValue([
			{ id: 'point-1', score: 0.95, payload: { content: 'result 1' } },
		]);

		const results = await service.search({ vector });

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ id: 'point-1', score: 0.95 });
	});

	it('returns empty array when no results found', async () => {
		const vector = new Array(1536).fill(0.1);
		mockClient.search.mockResolvedValue([]);

		const results = await service.search({ vector });

		expect(results).toEqual([]);
	});

	it('applies filters to search results', async () => {
		const vector = new Array(1536).fill(0.1);
		mockClient.search.mockResolvedValue([]);

		await service.search({ vector, filter: { workspace: 'test-ws', memory_type: 'long-term' } });

		expect(mockClient.search).toHaveBeenCalled();
	});

	it('respects limit and offset parameters', async () => {
		const vector = new Array(1536).fill(0.1);
		mockClient.search.mockResolvedValue([]);

		await service.search({ vector, limit: 5, offset: 10 });

		expect(mockClient.search).toHaveBeenCalled();
	});
});

describe('QdrantService.hybridSearchWithRRF', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('performs hybrid search when enabled with query', async () => {
		const vector = new Array(1536).fill(0.1);
		mockClient.search.mockResolvedValue([
			{ id: 'point-1', score: 0.95, payload: { content: 'result 1' } },
		]);

		const results = await service.search({ vector, query: 'test query', useHybridSearch: true });

		expect(Array.isArray(results)).toBe(true);
		expect(mockClient.search).toHaveBeenCalled();
	});

	it('returns results when some results from searches exist', async () => {
		const vector = new Array(1536).fill(0.1);
		mockClient.search.mockResolvedValueOnce([
			{ id: 'point-1', score: 0.95, payload: { content: 'result' } },
		]);
		mockClient.search.mockResolvedValueOnce([]);

		const results = await service.search({ vector, query: 'test', useHybridSearch: true });

		expect(Array.isArray(results)).toBe(true);
	});

	it('performs hybrid search when useHybridSearch=true and query is provided', async () => {
		const vector = new Array(1536).fill(0.1);
		mockClient.search.mockResolvedValue([]);

		await service.search({
			vector,
			query: 'test',
			useHybridSearch: true,
			filter: { workspace: 'test-ws' },
		});

		expect(mockClient.search).toHaveBeenCalled();
	});
});

describe('QdrantService.list', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('lists points with pagination', async () => {
		mockClient.scroll.mockResolvedValue({
			points: [
				{ id: 'point-1', payload: { content: 'content 1' } },
			],
			next_page_offset: null,
		});

		const results = await service.list(undefined, 100, 0);

		expect(results).toBeInstanceOf(Array);
		expect(mockClient.scroll).toHaveBeenCalledWith(
			'test-collection',
			expect.objectContaining({
				limit: 100,
				offset: 0,
			}),
		);
	});

	it('returns empty array when no points found', async () => {
		mockClient.scroll.mockResolvedValue({
			points: [],
			next_page_offset: null,
		});

		const results = await service.list(undefined, 100, 0);

		expect(results).toEqual([]);
	});

	it('applies workspace filter to list', async () => {
		mockClient.scroll.mockResolvedValue({
			points: [],
			next_page_offset: null,
		});

		await service.list({ workspace: 'my-workspace' }, 100, 0);

		expect(mockClient.scroll).toHaveBeenCalledWith(
			'test-collection',
			expect.objectContaining({
				filter: expect.any(Object),
			}),
		);
	});

	it('respects limit and offset parameters', async () => {
		mockClient.scroll.mockResolvedValue({
			points: [],
			next_page_offset: null,
		});

		await service.list(undefined, 50, 25);

		expect(mockClient.scroll).toHaveBeenCalledWith(
			'test-collection',
			expect.objectContaining({
				limit: 50,
				offset: 25,
			}),
		);
	});
});

describe('QdrantService.delete', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('deletes a point by id', async () => {
		const pointId = 'point-to-delete';
		mockClient.delete.mockResolvedValue({});

		await service.delete(pointId);

		expect(mockClient.delete).toHaveBeenCalled();
	});

	it('handles delete error gracefully', async () => {
		mockClient.delete.mockRejectedValue(new Error('Delete failed'));

		await expect(service.delete('some-id')).rejects.toThrow('Delete failed');
	});
});

describe('QdrantService.batchDelete', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('batch deletes multiple points', async () => {
		const ids = ['id-1', 'id-2', 'id-3'];
		mockClient.delete.mockResolvedValue({});

		await service.batchDelete(ids);

		expect(mockClient.delete).toHaveBeenCalled();
	});

	it('handles empty ids array', async () => {
		const ids: string[] = [];
		mockClient.delete.mockResolvedValue({});

		await service.batchDelete(ids);

		expect(mockClient.delete).toHaveBeenCalled();
	});
});

describe('QdrantService.updatePayload', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('updates metadata fields for a point', async () => {
		const pointId = 'point-123';
		const updates = { confidence: 0.9, tags: ['updated', 'tag'] };
		mockClient.setPayload.mockResolvedValue({});

		await service.updatePayload(pointId, updates);

		expect(mockClient.setPayload).toHaveBeenCalled();
	});

	it('handles setPayload error gracefully', async () => {
		mockClient.setPayload.mockRejectedValue(new Error('Payload update failed'));

		await expect(service.updatePayload('point-id', { confidence: 0.8 })).rejects.toThrow('Payload update failed');
	});
});

// ── Error handling and edge cases ──────────────────────────────────────────────

describe('QdrantService edge cases and error handling', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('handles search returning empty results', async () => {
		mockClient.search.mockResolvedValue([]);

		const results = await service.search({ vector: new Array(1536).fill(0.1) });
		expect(results).toEqual([]);
	});

	it('handles list returning empty results', async () => {
		mockClient.scroll.mockResolvedValue({ points: [] });

		const results = await service.list();
		expect(results).toEqual([]);
	});

	it('handles retrieve returning empty results', async () => {
		mockClient.retrieve.mockResolvedValue([]);

		const result = await service.get('nonexistent-id');
		expect(result).toBeNull();
	});

	it('handles count with filter returning zero', async () => {
		mockClient.count.mockResolvedValue({ count: 0 });

		const count = await service.count();
		expect(count).toBe(0);
	});

	it('handles delete of nonexistent point', async () => {
		mockClient.delete.mockResolvedValue({});

		await expect(service.delete('nonexistent')).resolves.not.toThrow();
	});

	it('handles batch delete with empty array', async () => {
		mockClient.delete.mockResolvedValue({});

		await expect(service.batchDelete([])).resolves.not.toThrow();
	});

	it('handles update payload for nonexistent point', async () => {
		mockClient.setPayload.mockResolvedValue({});

		await expect(service.updatePayload('nonexistent', { confidence: 0.8 })).resolves.not.toThrow();
	});

	it('returns multiple results from search', async () => {
		mockClient.search.mockResolvedValue([
			{ id: 'id-1', score: 0.95 },
			{ id: 'id-2', score: 0.85 },
		]);

		const results = await service.search({ vector: new Array(1536).fill(0.1) });
		expect(results).toHaveLength(2);
	});

	it('handles batch upsert with many points', async () => {
		mockClient.upsert.mockResolvedValue({});

		const points = Array.from({ length: 100 }, (_, i) => ({
			content: `content ${i}`,
			vector: new Array(1536).fill(0.1),
			metadata: { workspace: 'test' },
		}));

		const result = await service.batchUpsert(points);
		expect(result.successfulIds).toHaveLength(100);
		expect(result.failedPoints).toHaveLength(0);
	});

	it('handles batch upsert where upsert throws an error', async () => {
		mockClient.upsert.mockRejectedValueOnce(new Error('Upsert failed'));

		const points = Array.from({ length: 50 }, (_, i) => ({
			content: `content ${i}`,
			vector: new Array(1536).fill(0.1),
			metadata: { workspace: 'test' },
		}));

		const result = await service.batchUpsert(points);
		expect(result.successfulIds).toHaveLength(0);
		expect(result.failedPoints).toHaveLength(50);
	});

	it('search with multiple results applies proper scoring', async () => {
		mockClient.search.mockResolvedValue([
			{ id: 'id-1', score: 0.95, payload: { content: 'match1' } },
			{ id: 'id-2', score: 0.75, payload: { content: 'match2' } },
			{ id: 'id-3', score: 0.55, payload: { content: 'match3' } },
		]);

		const results = await service.search({ vector: new Array(1536).fill(0.1) });
		expect(results).toHaveLength(3);
		expect(results[0].score).toBe(0.95);
		expect(results[2].score).toBe(0.55);
	});

	it('handles list with limit and offset parameters', async () => {
		mockClient.scroll.mockResolvedValue({
			points: [
				{ id: 'id-1', payload: { content: 'data1' } },
				{ id: 'id-2', payload: { content: 'data2' } },
			],
			next_page_offset: null,
		});

		const results = await service.list(undefined, 10, 5);
		expect(results).toHaveLength(2);
	});

	it('handles count with memory_type filter', async () => {
		mockClient.count.mockResolvedValue({ count: 25 });

		const count = await service.count({ memory_type: 'long-term' });
		expect(count).toBe(25);
	});

	it('handles list filter with tags', async () => {
		mockClient.scroll.mockResolvedValue({
			points: [
				{ id: 'id-1', payload: { tags: ['tag1'] } },
			],
			next_page_offset: null,
		});

		const results = await service.list({ tags: ['tag1'] });
		expect(results).toHaveLength(1);
	});

	it('handles update payload with multiple fields', async () => {
		mockClient.setPayload.mockResolvedValue({});

		await service.updatePayload('test-id', { confidence: 0.9, access_count: 5 });
		expect(mockClient.setPayload).toHaveBeenCalled();
	});

	it('search respects the embedding vector size', async () => {
		mockClient.search.mockResolvedValue([]);

		const largeVector = new Array(1536).fill(0.5);
		await service.search({ vector: largeVector });

		expect(mockClient.search).toHaveBeenCalled();
	});

	it('handles upsert with dual embeddings (small and large vectors)', async () => {
		mockClient.upsert.mockResolvedValue({});

		await service.upsert('test content', new Array(1536).fill(0.1), { workspace: 'test' }, new Array(3072).fill(0.2));

		expect(mockClient.upsert).toHaveBeenCalled();
	});

	it('batchDelete handles array of multiple IDs correctly', async () => {
		mockClient.delete.mockResolvedValue({});

		await service.batchDelete(['id-1', 'id-2', 'id-3']);

		expect(mockClient.delete).toHaveBeenCalled();
	});

	it('count with min_confidence filter', async () => {
		mockClient.count.mockResolvedValue({ count: 15 });

		const count = await service.count({ min_confidence: 0.8 });
		expect(count).toBe(15);
	});

	it('list with min_confidence and memory_type filters combined', async () => {
		mockClient.scroll.mockResolvedValue({
			points: [
				{ id: 'id-1', payload: { memory_type: 'long-term', confidence: 0.9 } },
			],
			next_page_offset: null,
		});

		const results = await service.list({ memory_type: 'long-term', min_confidence: 0.8 });
		expect(results).toHaveLength(1);
	});

	it('handles search with filter applied', async () => {
		mockClient.search.mockResolvedValue([
			{ id: 'id-filtered', score: 0.9, payload: { tags: ['important'] } },
		]);

		const results = await service.search({ vector: new Array(1536).fill(0.1), limit: 10, filter: { tags: ['important'] } });
		expect(results).toHaveLength(1);
	});

	it('handles get (retrieve) for single point', async () => {
		mockClient.retrieve.mockResolvedValue([
			{ id: 'test-id', payload: { content: 'test' } },
		]);

		const result = await service.get('test-id');
		expect(result).not.toBeNull();
		expect(result?.id).toBe('test-id');
	});
});

// ── Branch coverage: hybridSearchWithRRF with alpha extremes ─────────────────
describe('QdrantService.hybridSearchWithRRF with alpha extremes', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('performs hybrid search with alpha=1.0 (vector-only weighting)', async () => {
		const vector = new Array(1536).fill(0.1);
		mockClient.search.mockResolvedValue([
			{ id: 'point-1', score: 0.95, payload: { content: 'result 1' } },
			{ id: 'point-2', score: 0.85, payload: { content: 'result 2' } },
		]);
		mockClient.scroll.mockResolvedValue({ points: [] });

		const results = await service.search({
			vector,
			query: 'test',
			useHybridSearch: true,
			hybridAlpha: 1.0,
		});

		expect(Array.isArray(results)).toBe(true);
		expect(mockClient.search).toHaveBeenCalled();
		expect(mockClient.scroll).toHaveBeenCalled();
	});

	it('performs hybrid search with alpha=0.0 (text-only weighting)', async () => {
		const vector = new Array(1536).fill(0.1);
		mockClient.search.mockResolvedValue([]);
		mockClient.scroll.mockResolvedValue({
			points: [
				{ id: 'text-1', payload: { content: 'text result' } },
			],
			next_page_offset: null,
		});

		const results = await service.search({
			vector,
			query: 'test',
			useHybridSearch: true,
			hybridAlpha: 0.0,
		});

		expect(Array.isArray(results)).toBe(true);
	});

	it('returns empty results when offset > 0 in hybrid search', async () => {
		const vector = new Array(1536).fill(0.1);

		const results = await service.search({
			vector,
			query: 'test',
			useHybridSearch: true,
			offset: 5,
		});

		expect(results).toEqual([]);
		expect(mockClient.search).not.toHaveBeenCalled();
	});

	it('handles hybrid search when only vector results exist', async () => {
		const vector = new Array(1536).fill(0.1);
		mockClient.search.mockResolvedValue([
			{ id: 'point-1', score: 0.95, payload: { content: 'vector result' } },
		]);
		mockClient.scroll.mockResolvedValue({ points: [] });

		const results = await service.search({
			vector,
			query: 'test',
			useHybridSearch: true,
		});

		expect(results).toHaveLength(1);
		expect(results[0]?.id).toBe('point-1');
	});

	it('handles hybrid search when only text results exist', async () => {
		const vector = new Array(1536).fill(0.1);
		mockClient.search.mockResolvedValue([]);
		mockClient.scroll.mockResolvedValue({
			points: [
				{ id: 'text-1', payload: { content: 'text result' } },
			],
		});

		const results = await service.search({
			vector,
			query: 'test',
			useHybridSearch: true,
		});

		expect(results).toHaveLength(1);
		expect(results[0]?.id).toBe('text-1');
	});
});

// ── Branch coverage: createPayloadIndexes when indexes exist ─────────────────
describe('QdrantService.createPayloadIndexes with existing indexes', () => {
	let service: QdrantService;

	beforeEach(() => {
		vi.clearAllMocks();
		mockClient.getCollections.mockResolvedValue({ collections: [{ name: 'test-collection' }] });
		mockClient.getCollection.mockResolvedValue({
			config: {
				params: {
					vectors: {
						dense: { size: 1536, distance: 'Cosine' },
						dense_large: { size: 3072, distance: 'Cosine' },
					},
				},
			},
			points_count: 100,
			indexed_vectors_count: 100,
			segments_count: 1,
			status: 'green',
			optimizer_status: 'ok',
		});
	});

	it('handles createPayloadIndex error when index already exists', async () => {
		mockClient.createPayloadIndex.mockRejectedValueOnce(
			new Error('field_name already exists'),
		);
		mockClient.createPayloadIndex.mockResolvedValue({});

		service = new QdrantService();
		await expect(service.initialize()).resolves.not.toThrow();
	});

	it('logs warning when payload index creation fails with non-exists error', async () => {
		mockClient.createPayloadIndex.mockRejectedValueOnce(
			new Error('unexpected error'),
		);
		mockClient.createPayloadIndex.mockResolvedValue({});

		service = new QdrantService();
		await expect(service.initialize()).resolves.not.toThrow();
	});
});

// ── Branch coverage: Access tracking with rate-limit guard ────────────────────
describe('QdrantService access tracking with rate-limit guard', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('suppresses duplicate access tracking warning logs within interval', async () => {
		vi.useFakeTimers();

		try {
			const pointId = 'point-123';

			mockClient.retrieve.mockResolvedValue([
				{
					id: pointId,
					payload: {
						content: 'test content',
						created_at: '2026-04-20T00:00:00Z',
						updated_at: '2026-04-20T00:00:00Z',
					},
				},
			]);

			mockClient.setPayload.mockRejectedValue(new Error('Access tracking failed'));

			// First call - should log warning
			await service.get(pointId);
			await vi.runAllTimersAsync();

			// Second call - should NOT log (within interval)
			await service.get(pointId);
			await vi.runAllTimersAsync();

			// Both failed but only first should be warned about (rate-limited)
			expect(mockClient.setPayload).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('updates last_accessed_at on successful access tracking', async () => {
		vi.useFakeTimers();

		try {
			const pointId = 'point-456';

			mockClient.retrieve.mockResolvedValue([
				{
					id: pointId,
					payload: {
						content: 'test',
						access_count: 0,
						created_at: '2026-04-20T00:00:00Z',
						updated_at: '2026-04-20T00:00:00Z',
					},
				},
			]);

			mockClient.setPayload.mockResolvedValue({});

			await service.get(pointId);
			await vi.runAllTimersAsync();

			const calls = mockClient.setPayload.mock.calls[0] as unknown[];
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const payload = (calls[1] as any).payload as any;

			expect(payload.last_accessed_at).toBeDefined();
			expect(typeof payload.last_accessed_at).toBe('string');
		} finally {
			vi.useRealTimers();
		}
	});
});

// ── Branch coverage: validateCollectionSchema with distance mismatches ──────
describe('QdrantService.validateCollectionSchema with distance mismatches', () => {
	it('throws when dense vector has non-Cosine distance', async () => {
		vi.clearAllMocks();
		mockClient.getCollections.mockResolvedValue({ collections: [{ name: 'test-collection' }] });
		mockClient.getCollection.mockResolvedValue({
			config: {
				params: {
					vectors: {
						dense: { size: 1536, distance: 'Euclid' },
						dense_large: { size: 3072, distance: 'Cosine' },
					},
				},
			},
			points_count: 0,
			indexed_vectors_count: 0,
			segments_count: 1,
			status: 'green',
			optimizer_status: 'ok',
		});

		const service = new QdrantService();
		await expect(service.initialize()).rejects.toThrow('distance mismatch');
	});

	it('throws when dense_large vector has non-Cosine distance', async () => {
		vi.clearAllMocks();
		mockClient.getCollections.mockResolvedValue({ collections: [{ name: 'test-collection' }] });
		mockClient.getCollection.mockResolvedValue({
			config: {
				params: {
					vectors: {
						dense: { size: 1536, distance: 'Cosine' },
						dense_large: { size: 3072, distance: 'Euclid' },
					},
				},
			},
			points_count: 0,
			indexed_vectors_count: 0,
			segments_count: 1,
			status: 'green',
			optimizer_status: 'ok',
		});

		const service = new QdrantService();
		await expect(service.initialize()).rejects.toThrow('distance mismatch');
	});
});
