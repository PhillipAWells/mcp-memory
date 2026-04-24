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
