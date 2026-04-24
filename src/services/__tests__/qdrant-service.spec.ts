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

// ── buildFilter (tested via count) ────────────────────────────────────────────

describe('QdrantService.buildFilter (via count)', () => {
	let service: QdrantService;

	beforeEach(async () => {
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
		service = new QdrantService();
		await service.initialize();
		vi.clearAllMocks();
		mockClient.count.mockResolvedValue({ count: 0 });
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
		const conditions = (args as any).filter.must;
		const workspaceCond = conditions.find((c: any) => c.key === 'workspace');
		expect(workspaceCond).toBeDefined();
		expect(workspaceCond.match.value).toBe('my-ws');
	});

	it('includes memory_type condition when filter is set', async () => {
		await service.count({ memory_type: 'episodic' });
		const [, args] = mockClient.count.mock.calls[0] as unknown[];
		const conditions = (args as any).filter.must;
		const typeCond = conditions.find((c: any) => c.key === 'memory_type');
		expect(typeCond?.match.value).toBe('episodic');
	});

	it('includes min_confidence range condition', async () => {
		await service.count({ min_confidence: 0.8 });
		const [, args] = mockClient.count.mock.calls[0] as unknown[];
		const conditions = (args as any).filter.must;
		const confCond = conditions.find((c: any) => c.key === 'confidence');
		expect(confCond?.range.gte).toBe(0.8);
	});

	it('includes tags any-match condition', async () => {
		await service.count({ tags: ['foo', 'bar'] });
		const [, args] = mockClient.count.mock.calls[0] as unknown[];
		const conditions = (args as any).filter.must;
		const tagCond = conditions.find((c: any) => c.key === 'tags');
		expect(tagCond?.match.any).toEqual(['foo', 'bar']);
	});

	it('always adds expires_at exclusion condition', async () => {
		await service.count({});
		const [, args] = mockClient.count.mock.calls[0] as unknown[];
		const conditions = (args as any).filter.must;
		const expiryCond = conditions.find((c: any) => 'should' in c);
		expect(expiryCond).toBeDefined();
		expect(expiryCond.should).toHaveLength(2);
	});

	it('includes custom metadata key-value conditions', async () => {
		await service.count({ metadata: { chunk_group_id: 'abc-123' } });
		const [, args] = mockClient.count.mock.calls[0] as unknown[];
		const conditions = (args as any).filter.must;
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
		service = new QdrantService();
		await service.initialize();
		vi.clearAllMocks();
	});

	it('increments access_count correctly on point retrieval', async () => {
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
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Verify setPayload was called with incremented access_count
		expect(mockClient.setPayload).toHaveBeenCalledWith(
			'test-collection',
			expect.objectContaining({
				wait: false,
				points: expect.arrayContaining([
					expect.objectContaining({
						id: pointId,
						payload: expect.objectContaining({
							access_count: currentAccessCount + 1,
						}),
					}),
				]),
			}),
		);
	});

	it('handles zero initial access_count correctly', async () => {
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
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Verify access_count is set to 1 (0 + 1)
		expect(mockClient.setPayload).toHaveBeenCalledWith(
			'test-collection',
			expect.objectContaining({
				points: expect.arrayContaining([
					expect.objectContaining({
						id: pointId,
						payload: expect.objectContaining({
							access_count: 1,
						}),
					}),
				]),
			}),
		);
	});

	it('updates last_accessed_at timestamp on retrieval', async () => {
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
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Verify setPayload includes a new last_accessed_at timestamp
		const call = mockClient.setPayload.mock.calls[0];
		const setPayloadArgs = call[1] as any;
		const point = setPayloadArgs.points[0] as any;

		expect(point.payload.last_accessed_at).toBeDefined();
		// Verify it's an ISO 8601 timestamp with milliseconds
		expect(point.payload.last_accessed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
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
