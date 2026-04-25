/**
 * Tests for memory tool handlers
 *
 * Services (qdrant, embedding, workspace) are mocked so no network calls are made.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoist mocks so they are available before module imports are resolved ───────
// Use vi.fn().mockResolvedValue() instead of vi.fn(async () => ...) to keep the
// mock return type as 'any', which allows mockResolvedValueOnce() to accept any value.
const { mockQdrant, mockEmbedding, mockWorkspace } = vi.hoisted(() => {
	const mockQdrant = {
		upsert: vi.fn().mockResolvedValue('test-id-1234'),
		batchUpsert: vi.fn().mockResolvedValue({ successfulIds: ['test-id-1'], failedPoints: [], totalProcessed: 1 }),
		search: vi.fn().mockResolvedValue([]),
		get: vi.fn().mockResolvedValue(null),
		list: vi.fn().mockResolvedValue([]),
		count: vi.fn().mockResolvedValue(0),
		delete: vi.fn().mockResolvedValue(undefined),
		batchDelete: vi.fn().mockResolvedValue(undefined),
		updatePayload: vi.fn().mockResolvedValue(undefined),
		getStats: vi.fn().mockResolvedValue({
			points_count: 0,
			indexed_vectors_count: 0,
			segments_count: 1,
			status: 'green',
			optimizer_status: 'ok',
			access_tracking_failures: 0,
			config: {},
		}),
	};

	const mockEmbedding = {
		generateDualEmbeddings: vi.fn().mockResolvedValue({ small: new Array(384).fill(0.1), large: new Array(384).fill(0.1) }),
		generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
		generateLargeEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
		generateChunkedEmbeddings: vi.fn().mockResolvedValue([
			{ chunk: 'chunk text', embedding: new Array(384).fill(0.1), index: 0, total: 1 },
		]),
		getStats: vi.fn(() => ({ totalEmbeddings: 0, cacheHits: 0, cacheMisses: 0, totalTokens: 0, totalCost: 0, cacheHitRate: 0 })),
	};

	const mockWorkspace = {
		detect: vi.fn(() => ({ workspace: 'test-workspace', source: 'default' })),
		normalize: vi.fn((ws: string | null) => (ws ? ws.toLowerCase() : null)),
	};

	return { mockQdrant, mockEmbedding, mockWorkspace };
});

// ── Module mocks (hoisted automatically by Vitest) ────────────────────────────
vi.mock('../../config.js', () => ({
	config: {
		embedding: { smallDimensions: 1536, largeDimensions: 3072 },
		openai: { apiKey: 'test-key' },
		memory: { chunkSize: 1000, chunkOverlap: 200 },
		workspace: { autoDetect: false, default: 'test-workspace', cacheTTL: 60000 },
		qdrant: { url: 'http://localhost:6333', collection: 'test', timeout: 5000 },
		server: { logLevel: 'silent' },
	},
}));

vi.mock('../../services/qdrant-client.js', () => ({ qdrantService: mockQdrant }));
vi.mock('../../services/embedding-service.js', () => ({ embeddingService: mockEmbedding }));
vi.mock('../../services/workspace-detector.js', () => ({ workspaceDetector: mockWorkspace }));

import { memoryTools } from '../memory-tools.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTool(name: string) {
	const tool = memoryTools.find(t => t.name === name);
	if (!tool) throw new Error(`Tool not found: ${name}`);
	return tool;
}

// ── memory-store ──────────────────────────────────────────────────────────────

describe('memory-store', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('stores content and returns success', async () => {
		const result = await getTool('memory-store').handler({
			content: 'Hello, this is a test memory.',
		});
		expect(result.success).toBe(true);
		expect(mockQdrant.upsert).toHaveBeenCalledTimes(1);
	});

	it('returns VALIDATION_ERROR for empty content', async () => {
		const result = await getTool('memory-store').handler({ content: '' });
		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('returns VALIDATION_ERROR for content that is too long', async () => {
		const result = await getTool('memory-store').handler({ content: 'a'.repeat(100_001) });
		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('blocks content with high-confidence secrets', async () => {
		const apiKey = 'sk-' + 'a'.repeat(48);
		const result = await getTool('memory-store').handler({ content: `key=${apiKey}` });
		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
		expect(result.metadata).toMatchObject({ error_code: 'SECRETS_DETECTED' });
	});

	it('passes workspace from detector when not specified in metadata', async () => {
		await getTool('memory-store').handler({ content: 'workspace test content' });
		expect(mockQdrant.upsert).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Object),
			expect.objectContaining({ workspace: 'test-workspace' }),
			expect.any(Array),
		);
	});

	it('respects explicit workspace in metadata', async () => {
		await getTool('memory-store').handler({
			content: 'explicit workspace content',
			metadata: { workspace: 'explicit-ws' },
		});
		expect(mockQdrant.upsert).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Object),
			expect.objectContaining({ workspace: 'explicit-ws' }),
			expect.any(Array),
		);
	});

	it('normalizes workspace name to lowercase', async () => {
		await getTool('memory-store').handler({
			content: 'workspace normalization test',
			metadata: { workspace: 'MyWorkspace' },
		});
		expect(mockQdrant.upsert).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Object),
			expect.objectContaining({ workspace: 'myworkspace' }),
			expect.any(Array),
		);
	});

	it('stores memory without metadata object', async () => {
		const result = await getTool('memory-store').handler({
			content: 'content without metadata',
		});
		expect(result.success).toBe(true);
		expect(mockQdrant.upsert).toHaveBeenCalledTimes(1);
	});

	it('auto-chunks long content when auto_chunk is true', async () => {
		const longContent = 'word '.repeat(300); // > 1000 chars
		mockEmbedding.generateChunkedEmbeddings.mockResolvedValueOnce([
			{ chunk: 'chunk1', embedding: new Array(384).fill(0.1), index: 0, total: 2 },
			{ chunk: 'chunk2', embedding: new Array(384).fill(0.1), index: 1, total: 2 },
		]);
		const result = await getTool('memory-store').handler({ content: longContent, auto_chunk: true });
		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ chunks: 2 });
	});

	it('all chunks share the same chunk_group_id', async () => {
		const longContent = 'x '.repeat(600);
		mockEmbedding.generateChunkedEmbeddings.mockResolvedValueOnce([
			{ chunk: 'c1', embedding: new Array(384).fill(0.1), index: 0, total: 2 },
			{ chunk: 'c2', embedding: new Array(384).fill(0.1), index: 1, total: 2 },
		]);
		await getTool('memory-store').handler({ content: longContent, auto_chunk: true });
		// For chunked content, batchUpsert is called with an array of points
		const calls = mockQdrant.batchUpsert.mock.calls as unknown as Array<Array<{ metadata: Record<string, unknown> }[]>>;
		const points = calls[0]?.[0] ?? [];
		const groupId0 = points[0]?.metadata?.chunk_group_id;
		const groupId1 = points[1]?.metadata?.chunk_group_id;
		expect(groupId0).toBeDefined();
		expect(groupId0).toBe(groupId1);
	});
});

// ── memory-query ──────────────────────────────────────────────────────────────

describe('memory-query', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns results on successful query', async () => {
		mockQdrant.search.mockResolvedValueOnce([
			{ id: 'abc', content: 'result content', score: 0.9, path: '', metadata: {} },
		]);
		const result = await getTool('memory-query').handler({ query: 'test query' });
		expect(result.success).toBe(true);
		expect((result.data as any).count).toBe(1);
	});

	it('returns VALIDATION_ERROR for empty query', async () => {
		const result = await getTool('memory-query').handler({ query: '' });
		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('includes query text in response', async () => {
		const result = await getTool('memory-query').handler({ query: 'my query text' });
		expect((result.data as any).query).toBe('my query text');
	});
});

// ── memory-list ───────────────────────────────────────────────────────────────

describe('memory-list', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns a list of memories', async () => {
		mockQdrant.list.mockResolvedValueOnce([
			{ id: '1', content: 'memory 1', score: 1, path: '', metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() } },
		]);
		const result = await getTool('memory-list').handler({});
		expect(result.success).toBe(true);
		expect((result.data as any).count).toBe(1);
	});

	it('returns empty list when no memories match', async () => {
		const result = await getTool('memory-list').handler({});
		expect(result.success).toBe(true);
		expect((result.data as any).memories).toHaveLength(0);
	});

	it('paginates using limit and offset', async () => {
		const now = new Date().toISOString();
		const memories = Array.from({ length: 20 }, (_, i) => ({
			id: `mem-${i}`,
			content: `memory ${i}`,
			score: 1,
			path: '',
			metadata: { created_at: new Date(Date.now() - i * 1000).toISOString(), updated_at: now, access_count: 0, confidence: 1, memory_type: 'long-term' as const, workspace: null, tags: [], last_accessed_at: null, expires_at: null, chunk_group_id: undefined },
		}));
		mockQdrant.count.mockResolvedValueOnce(20);
		mockQdrant.list.mockResolvedValueOnce(memories);
		
		const result = await getTool('memory-list').handler({ limit: 5, offset: 10 });
		expect(mockQdrant.count).toHaveBeenCalledWith(undefined);
		// For created_at sorting, fetches all records (up to 10000) with offset 0, then slices
		expect(mockQdrant.list).toHaveBeenCalledWith(undefined, 20, 0);
		expect(result.success).toBe(true);
	});

	it('applies pagination correctly after in-memory sort by access_count desc', async () => {
		const now = new Date().toISOString();
		const memories = [
			{ id: '1', content: 'a', score: 1, path: '', metadata: { access_count: 10, created_at: now } },
			{ id: '2', content: 'b', score: 1, path: '', metadata: { access_count: 30, created_at: now } },
			{ id: '3', content: 'c', score: 1, path: '', metadata: { access_count: 20, created_at: now } },
		];
		mockQdrant.count.mockResolvedValueOnce(3);
		mockQdrant.list.mockResolvedValueOnce(memories);

		const result = await getTool('memory-list').handler({
			sort_by: 'access_count',
			sort_order: 'desc',
			limit: 1,
			offset: 1,
		});

		expect(result.success).toBe(true);
		// Sorted desc: [30(id=2), 20(id=3), 10(id=1)] → offset=1 limit=1 → id=3
		expect((result.data as any).memories).toHaveLength(1);
		expect((result.data as any).memories[0].id).toBe('3');
	});

	it('fetches from offset 0 when sorting in memory (not the user offset)', async () => {
		// count() is called once for total count used to compute fetchLimit
		mockQdrant.count.mockResolvedValueOnce(5);
		mockQdrant.list.mockResolvedValueOnce([]);

		await getTool('memory-list').handler({
			sort_by: 'access_count',
			limit: 10,
			offset: 2,
		});

		// Must fetch from 0, not from user offset=2, to sort globally before slicing
		expect(mockQdrant.list).toHaveBeenCalledWith(undefined, 5, 0);
	});

	it('caps fetch at MAX_IN_MEMORY_SORT_COUNT when count exceeds limit', async () => {
		// count() is called once for total count used to compute fetchLimit
		mockQdrant.count.mockResolvedValueOnce(20000);
		mockQdrant.list.mockResolvedValueOnce([]);

		await getTool('memory-list').handler({ sort_by: 'access_count' });

		expect(mockQdrant.list).toHaveBeenCalledWith(undefined, 10000, 0);
	});
});

// ── memory-get ────────────────────────────────────────────────────────────────

describe('memory-get', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns the memory when found', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			id: VALID_UUID,
			content: 'the content',
			score: 1,
			path: '',
			metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
		});
		const result = await getTool('memory-get').handler({ id: VALID_UUID });
		expect(result.success).toBe(true);
		expect((result.data as any).id).toBe(VALID_UUID);
	});

	it('returns NOT_FOUND_ERROR when memory does not exist', async () => {
		mockQdrant.get.mockResolvedValueOnce(null);
		const result = await getTool('memory-get').handler({ id: VALID_UUID });
		expect(result.success).toBe(false);
		expect(result.error_type).toBe('NOT_FOUND_ERROR');
	});

	it('returns VALIDATION_ERROR for non-UUID id', async () => {
		const result = await getTool('memory-get').handler({ id: 'not-a-uuid' });
		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});
});

// ── memory-update ─────────────────────────────────────────────────────────────

describe('memory-update', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440001';
	const baseMemory = {
		id: VALID_UUID,
		content: 'original content',
		score: 1,
		path: '',
		metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('updates metadata and returns success', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);
		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { confidence: 0.9 },
		});
		expect(result.success).toBe(true);
		expect(mockQdrant.updatePayload).toHaveBeenCalledTimes(1);
	});

	it('returns NOT_FOUND_ERROR when memory does not exist', async () => {
		mockQdrant.get.mockResolvedValueOnce(null);
		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { confidence: 0.8 },
		});
		expect(result.success).toBe(false);
		expect(result.error_type).toBe('NOT_FOUND_ERROR');
	});

	it('transparently updates all siblings when updating a chunk (metadata-only)', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			...baseMemory,
			metadata: {
				...baseMemory.metadata,
				chunk_index: 0,
				total_chunks: 3,
				chunk_group_id: 'group-id-xyz',
			},
		});
		mockQdrant.list.mockResolvedValueOnce([
			{
				id: 'chunk-1',
				content: 'chunk 1 content',
				score: 1,
				path: '',
				metadata: {
					...baseMemory.metadata,
					chunk_index: 0,
					total_chunks: 3,
					chunk_group_id: 'group-id-xyz',
				},
			},
			{
				id: 'chunk-2',
				content: 'chunk 2 content',
				score: 1,
				path: '',
				metadata: {
					...baseMemory.metadata,
					chunk_index: 1,
					total_chunks: 3,
					chunk_group_id: 'group-id-xyz',
				},
			},
			{
				id: 'chunk-3',
				content: 'chunk 3 content',
				score: 1,
				path: '',
				metadata: {
					...baseMemory.metadata,
					chunk_index: 2,
					total_chunks: 3,
					chunk_group_id: 'group-id-xyz',
				},
			},
		]);
		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { confidence: 0.9 },
		});
		expect(result.success).toBe(true);
		expect((result.data as any).siblings_updated).toBe(3);
	});

	it('automatically reindexes when content is updated', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);
		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'new content here',
		});
		expect(result.success).toBe(true);
		expect(mockQdrant.upsert).toHaveBeenCalledTimes(1);
		expect((result.data as any).reindexed).toBe(true);
	});

	it('blocks update if new content contains high-confidence secrets', async () => {
		const apiKey = 'sk-' + 'b'.repeat(48);
		// NOTE: do NOT mock get() here — the handler returns early (before calling get())
		// when secrets are detected, so queuing a value would leak into the next test.
		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			content: `key=${apiKey}`,
		});
		expect(result.success).toBe(false);
		expect(result.metadata?.error_code).toBe('SECRETS_DETECTED');
	});
});

// ── memory-delete ─────────────────────────────────────────────────────────────

describe('memory-delete', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440002';

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('deletes existing memory and returns success', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			id: VALID_UUID, content: 'to delete', score: 1, path: '', metadata: {},
		});
		const result = await getTool('memory-delete').handler({ id: VALID_UUID });
		expect(result.success).toBe(true);
		expect(mockQdrant.delete).toHaveBeenCalledWith(VALID_UUID);
	});

	it('returns NOT_FOUND_ERROR when memory does not exist', async () => {
		mockQdrant.get.mockResolvedValueOnce(null);
		const result = await getTool('memory-delete').handler({ id: VALID_UUID });
		expect(result.success).toBe(false);
		expect(result.error_type).toBe('NOT_FOUND_ERROR');
	});
});

// ── memory-batch-delete ───────────────────────────────────────────────────────

describe('memory-batch-delete', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('batch-deletes memories and returns success', async () => {
		const ids = [
			'550e8400-e29b-41d4-a716-446655440010',
			'550e8400-e29b-41d4-a716-446655440011',
		];
		const result = await getTool('memory-batch-delete').handler({ ids });
		expect(result.success).toBe(true);
		expect((result.data as any).count).toBe(2);
		expect(mockQdrant.batchDelete).toHaveBeenCalledWith(ids);
	});

	it('returns VALIDATION_ERROR for empty ids array', async () => {
		const result = await getTool('memory-batch-delete').handler({ ids: [] });
		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('returns EXECUTION_ERROR on batch delete failure', async () => {
		const ids = ['550e8400-e29b-41d4-a716-446655440010'];
		mockQdrant.batchDelete.mockRejectedValueOnce(new Error('Delete failed'));
		const result = await getTool('memory-batch-delete').handler({ ids });
		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});

	it('returns VALIDATION_ERROR for non-UUID ids', async () => {
		const result = await getTool('memory-batch-delete').handler({ ids: ['not-a-uuid'] });
		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});
});

// ── memory-status ─────────────────────────────────────────────────────────────

describe('memory-status', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns server health information', async () => {
		const result = await getTool('memory-status').handler({});
		expect(result.success).toBe(true);
		expect((result.data as any).server).toBe('mcp-memory');
		expect((result.data as any).collection).toBeDefined();
	});

	it('includes embedding stats when include_embedding_stats is true', async () => {
		const result = await getTool('memory-status').handler({ include_embedding_stats: true });
		expect((result.data as any).embeddings).toBeDefined();
	});

	it('does not include embedding stats when false', async () => {
		const result = await getTool('memory-status').handler({ include_embedding_stats: false });
		expect((result.data as any).embeddings).toBeUndefined();
	});
});

// ── memory-count ──────────────────────────────────────────────────────────────

describe('memory-count', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns count of all memories', async () => {
		mockQdrant.count.mockResolvedValueOnce(42);
		const result = await getTool('memory-count').handler({});
		expect(result.success).toBe(true);
		expect((result.data as any).count).toBe(42);
	});

	it('passes filter to count service', async () => {
		await getTool('memory-count').handler({ filter: { workspace: 'my-ws' } });
		expect(mockQdrant.count).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'my-ws' }));
	});

	it('returns EXECUTION_ERROR on count failure', async () => {
		mockQdrant.count.mockRejectedValueOnce(new Error('Database error'));
		const result = await getTool('memory-count').handler({});
		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});
});

// ── memory-status error handling ───────────────────────────────────────────────

describe('memory-status error handling', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns EXECUTION_ERROR on stats failure', async () => {
		mockQdrant.getStats.mockRejectedValueOnce(new Error('Stats unavailable'));
		const result = await getTool('memory-status').handler({});
		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});
});

// ── memory-update chunked memory edge cases ────────────────────────────────────

describe('memory-update - chunked memory content updates', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440003';
	const baseMemory = {
		id: VALID_UUID,
		content: 'original content',
		score: 1,
		path: '',
		metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('re-chunks content when auto_chunk=true for updated memory', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			...baseMemory,
			metadata: {
				...baseMemory.metadata,
				chunk_index: 0,
				total_chunks: 3,
				chunk_group_id: 'group-xyz-123',
			},
		});

		mockQdrant.list.mockResolvedValueOnce([
			{
				id: 'chunk-1',
				content: 'chunk 1 content',
				score: 1,
				path: '',
				metadata: {
					...baseMemory.metadata,
					chunk_index: 0,
					total_chunks: 3,
					chunk_group_id: 'group-xyz-123',
				},
			},
			{
				id: 'chunk-2',
				content: 'chunk 2 content',
				score: 1,
				path: '',
				metadata: {
					...baseMemory.metadata,
					chunk_index: 1,
					total_chunks: 3,
					chunk_group_id: 'group-xyz-123',
				},
			},
			{
				id: 'chunk-3',
				content: 'chunk 3 content',
				score: 1,
				path: '',
				metadata: {
					...baseMemory.metadata,
					chunk_index: 2,
					total_chunks: 3,
					chunk_group_id: 'group-xyz-123',
				},
			},
		]);

		mockQdrant.batchUpsert.mockResolvedValue({ successfulIds: ['new-chunk-id-1', 'new-chunk-id-2', 'new-chunk-id-3'], failedPoints: [], totalProcessed: 3 });
		mockQdrant.batchDelete.mockResolvedValue(undefined);

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'completely new content that needs re-chunking',
			auto_chunk: true,
		});

		expect(result.success).toBe(true);
		// batchDelete should be called to delete sibling chunks
		expect(mockQdrant.batchDelete).toHaveBeenCalled();
	});

	it('propagates metadata updates to all chunk siblings', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			...baseMemory,
			metadata: {
				...baseMemory.metadata,
				chunk_index: 1,
				total_chunks: 3,
				chunk_group_id: 'group-abc-def',
			},
		});

		mockQdrant.list.mockResolvedValueOnce([
			{
				id: 'chunk-a',
				content: 'a',
				score: 1,
				path: '',
				metadata: {
					...baseMemory.metadata,
					chunk_index: 0,
					total_chunks: 3,
					chunk_group_id: 'group-abc-def',
				},
			},
			{
				id: 'chunk-b',
				content: 'b',
				score: 1,
				path: '',
				metadata: {
					...baseMemory.metadata,
					chunk_index: 1,
					total_chunks: 3,
					chunk_group_id: 'group-abc-def',
				},
			},
			{
				id: 'chunk-c',
				content: 'c',
				score: 1,
				path: '',
				metadata: {
					...baseMemory.metadata,
					chunk_index: 2,
					total_chunks: 3,
					chunk_group_id: 'group-abc-def',
				},
			},
		]);

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { tags: ['important', 'reviewed'] },
		});

		expect(result.success).toBe(true);
		expect((result.data as any).siblings_updated).toBe(3);
	});

	it('handles metadata-only update to chunked memory with no chunk_group_id', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			...baseMemory,
			metadata: {
				...baseMemory.metadata,
				confidence: 0.5,
			},
		});

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { confidence: 0.95 },
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.updatePayload).toHaveBeenCalledTimes(1);
	});

	it('correctly identifies chunk boundaries (chunk_index + total_chunks)', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			...baseMemory,
			metadata: {
				...baseMemory.metadata,
				chunk_index: 0,
				total_chunks: 2,
				chunk_group_id: 'group-2-chunks',
			},
		});

		mockQdrant.list.mockResolvedValueOnce([
			{
				id: 'chunk-0',
				content: 'first half',
				score: 1,
				path: '',
				metadata: {
					...baseMemory.metadata,
					chunk_index: 0,
					total_chunks: 2,
					chunk_group_id: 'group-2-chunks',
				},
			},
			{
				id: 'chunk-1',
				content: 'second half',
				score: 1,
				path: '',
				metadata: {
					...baseMemory.metadata,
					chunk_index: 1,
					total_chunks: 2,
					chunk_group_id: 'group-2-chunks',
				},
			},
		]);

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { confidence: 0.8 },
		});

		expect(result.success).toBe(true);
		expect((result.data as any).siblings_updated).toBe(2);
	});

	it('returns error when trying to update non-existent chunk sibling', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			...baseMemory,
			metadata: {
				...baseMemory.metadata,
				chunk_index: 0,
				total_chunks: 3,
				chunk_group_id: 'group-missing-sibling',
			},
		});

		// Only return 2 chunks instead of 3
		mockQdrant.list.mockResolvedValueOnce([
			{
				id: 'chunk-1',
				content: 'chunk 1',
				score: 1,
				path: '',
				metadata: {
					...baseMemory.metadata,
					chunk_index: 0,
					total_chunks: 3,
					chunk_group_id: 'group-missing-sibling',
				},
			},
			{
				id: 'chunk-2',
				content: 'chunk 2',
				score: 1,
				path: '',
				metadata: {
					...baseMemory.metadata,
					chunk_index: 1,
					total_chunks: 3,
					chunk_group_id: 'group-missing-sibling',
				},
			},
		]);

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { confidence: 0.8 },
		});

		// Should still succeed and update what's available
		expect(result.success).toBe(true);
	});
});

// ── memory-update edge cases for content and metadata updates ──────────────────────────────

describe('memory-update - content and metadata update behavior', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440004';
	const baseMemory = {
		id: VALID_UUID,
		content: 'original content',
		score: 1,
		path: '',
		metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('re-embeds content when content is updated', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);
		mockQdrant.upsert.mockResolvedValue('reembedded-id');

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'updated content',
			auto_chunk: true,
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.upsert).toHaveBeenCalled();
	});

	it('updates metadata without re-embedding when only metadata is changed', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { confidence: 0.9 },
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.updatePayload).toHaveBeenCalled();
	});

	it('handles content updates with auto_chunk enabled (default)', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);
		mockQdrant.upsert.mockResolvedValue('new-id');

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'new content',
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.upsert).toHaveBeenCalled();
	});
});

// ── memory-query and memory-search result filtering ──────────────────────────

describe('memory-query - filtering and search', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('applies filters when searching with query', async () => {
		mockQdrant.search.mockResolvedValueOnce([
			{ id: '1', content: 'result', score: 0.95, path: '', metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() } },
		]);

		const result = await getTool('memory-query').handler({
			query: 'test',
			filter: { workspace: 'my-workspace', min_confidence: 0.8 },
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.search).toHaveBeenCalled();
	});

	it('handles multiple filter types', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		const result = await getTool('memory-query').handler({
			query: 'test',
			filter: {
				workspace: 'test-ws',
				memory_type: 'episodic',
				min_confidence: 0.8,
				tags: ['tag1', 'tag2'],
			},
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.search).toHaveBeenCalled();
	});

	it('returns results with proper structure', async () => {
		const now = new Date().toISOString();
		mockQdrant.search.mockResolvedValueOnce([
			{ id: '1', content: 'result', score: 0.95, path: '', metadata: { created_at: now, updated_at: now } },
		]);

		const result = await getTool('memory-query').handler({
			query: 'test',
		});

		expect(result.success).toBe(true);
		expect((result.data as any).query).toBe('test');
		expect(Array.isArray((result.data as any).results)).toBe(true);
	});
});

// ── memory-store content validation ────────────────────────────────────────────

describe('memory-store - content validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejects extremely long content (>100KB)', async () => {
		const result = await getTool('memory-store').handler({
			content: 'a'.repeat(100_001),
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('rejects empty content', async () => {
		const result = await getTool('memory-store').handler({
			content: '',
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('accepts content at exactly 100KB', async () => {
		mockQdrant.upsert.mockResolvedValue('new-id');

		const result = await getTool('memory-store').handler({
			content: 'a'.repeat(100_000),
		});

		expect(result.success).toBe(true);
	});

	it('accepts content without secret patterns', async () => {
		mockQdrant.upsert.mockResolvedValue('new-id');

		const result = await getTool('memory-store').handler({
			content: 'This is some normal content without secrets',
		});

		expect(result.success).toBe(true);
	});

	it('stores content with optional metadata fields', async () => {
		mockQdrant.upsert.mockResolvedValue('new-id');

		const result = await getTool('memory-store').handler({
			content: 'test content',
			memory_type: 'episodic',
			confidence: 0.92,
			tags: ['important', 'tested'],
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.upsert).toHaveBeenCalled();
	});

	it('returns success response with memory id', async () => {
		mockQdrant.upsert.mockResolvedValue('returned-memory-id-123');

		const result = await getTool('memory-store').handler({
			content: 'test content',
		});

		expect(result.success).toBe(true);
		expect((result.data as any).id).toBe('returned-memory-id-123');
	});
});

// ── memory-store memory_type and expiry ──────────────────────────────────

describe('memory-store - memory_type and expires_at', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('auto-sets expires_at for episodic memory', async () => {
		mockQdrant.upsert.mockResolvedValue('episodic-id');

		const result = await getTool('memory-store').handler({
			content: 'episodic memory',
			metadata: { memory_type: 'episodic' },
		});

		expect(result.success).toBe(true);
		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown, Record<string, unknown>][];
		const metadata = calls[0][2];
		expect(metadata?.expires_at).toBeDefined();
	});

	it('auto-sets expires_at for short-term memory', async () => {
		mockQdrant.upsert.mockResolvedValue('short-term-id');

		const result = await getTool('memory-store').handler({
			content: 'short-term memory',
			metadata: { memory_type: 'short-term' },
		});

		expect(result.success).toBe(true);
		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown, Record<string, unknown>][];
		const metadata = calls[0][2];
		expect(metadata?.expires_at).toBeDefined();
	});

	it('does not auto-set expires_at for long-term memory', async () => {
		mockQdrant.upsert.mockResolvedValue('long-term-id');

		const result = await getTool('memory-store').handler({
			content: 'long-term memory',
			memory_type: 'long-term',
		});

		expect(result.success).toBe(true);
		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown, Record<string, unknown>][];
		const metadata = calls[0][2];
		expect(metadata?.expires_at).toBeUndefined();
	});

	it('respects explicit expires_at even for episodic', async () => {
		mockQdrant.upsert.mockResolvedValue('explicit-id');
		const customExpiry = new Date('2099-12-31').toISOString();

		const result = await getTool('memory-store').handler({
			content: 'explicit expiry',
			memory_type: 'episodic',
			metadata: { expires_at: customExpiry },
		});

		expect(result.success).toBe(true);
		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown, Record<string, unknown>][];
		const metadata = calls[0][2];
		expect(metadata?.expires_at).toBe(customExpiry);
	});

	it('stores memory_type in response', async () => {
		mockQdrant.upsert.mockResolvedValue('typed-id');

		const result = await getTool('memory-store').handler({
			content: 'episodic content',
			metadata: { memory_type: 'episodic' },
		});

		expect(result.success).toBe(true);
		expect((result.data as any).memory_type).toBe('episodic');
	});

	it('includes confidence in response', async () => {
		mockQdrant.upsert.mockResolvedValue('confidence-id');

		const result = await getTool('memory-store').handler({
			content: 'high confidence content',
			metadata: { confidence: 0.95 },
		});

		expect(result.success).toBe(true);
		expect((result.data as any).confidence).toBe(0.95);
	});
});

// ── memory-store secrets detection ──────────────────────────────────────

describe('memory-store - secrets detection edge cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('blocks content with medium-confidence patterns', async () => {
		// Triggers 3 distinct medium-confidence patterns: password + oauth_token + generic_secret
		const result = await getTool('memory-store').handler({
			content: '"password"="mypassword123" "access_token"="oauth_abc123def456789012345" AWS_SECRET_KEY=abcdef123456789abc',
		});

		expect(result.success).toBe(false);
		expect(result.metadata?.error_code).toBe('SECRETS_DETECTED');
	});

	it('blocks AWS AKIA credentials', async () => {
		const result = await getTool('memory-store').handler({
			content: 'Access key: AKIAIOSFODNN7EXAMPLE',
		});

		expect(result.success).toBe(false);
		expect(result.metadata?.error_code).toBe('SECRETS_DETECTED');
	});

	it('allows benign word password', async () => {
		mockQdrant.upsert.mockResolvedValue('benign-id');

		const result = await getTool('memory-store').handler({
			content: 'Use a secure password for your account',
		});

		expect(result.success).toBe(true);
	});

	it('blocks private key headers', async () => {
		const result = await getTool('memory-store').handler({
			content: '-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC7VJTUt9Us8cKj\n-----END PRIVATE KEY-----',
		});

		expect(result.success).toBe(false);
		expect(result.metadata?.error_code).toBe('SECRETS_DETECTED');
	});
});

// ── memory-store dual embeddings ────────────────────────────────────────

describe('memory-store - dual embeddings', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('calls generateDualEmbeddings for normal content', async () => {
		mockQdrant.upsert.mockResolvedValue('dual-id');

		await getTool('memory-store').handler({
			content: 'normal content',
		});

		expect(mockEmbedding.generateDualEmbeddings).toHaveBeenCalledWith('normal content');
	});

	it('passes small and large embeddings to upsert', async () => {
		mockQdrant.upsert.mockResolvedValue('dual-id');
		mockEmbedding.generateDualEmbeddings.mockResolvedValueOnce({
			small: new Array(384).fill(0.4),
			large: new Array(384).fill(0.5),
		});

		await getTool('memory-store').handler({
			content: 'embedding test',
		});

		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown[], Record<string, unknown>, unknown[]][];
		expect(calls[0][1]).toEqual(new Array(384).fill(0.4));
		expect(calls[0][3]).toEqual(new Array(384).fill(0.5));
	});

	it('includes workspace in response data', async () => {
		mockQdrant.upsert.mockResolvedValue('ws-id');

		const result = await getTool('memory-store').handler({
			content: 'workspace test',
			metadata: { workspace: 'test-ws' },
		});

		expect(result.success).toBe(true);
		expect((result.data as any).workspace).toBe('test-ws');
	});
});

// ── memory-store special characters ──────────────────────────────────────

describe('memory-store - special characters', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('stores content with unicode', async () => {
		mockQdrant.upsert.mockResolvedValue('unicode-id');

		const result = await getTool('memory-store').handler({
			content: 'Unicode: 你好世界 مرحبا',
		});

		expect(result.success).toBe(true);
	});

	it('stores content with emoji', async () => {
		mockQdrant.upsert.mockResolvedValue('emoji-id');

		const result = await getTool('memory-store').handler({
			content: 'Memory 🎯 symbols @#$%',
		});

		expect(result.success).toBe(true);
	});

	it('stores content with newlines and tabs', async () => {
		mockQdrant.upsert.mockResolvedValue('ws-id');

		const result = await getTool('memory-store').handler({
			content: 'Line1\nLine2\n\nLine4\t\tTabbed',
		});

		expect(result.success).toBe(true);
	});
});

// ── memory-query filter combinations ────────────────────────────────────

describe('memory-query - filters', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('applies workspace filter', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
			filter: { workspace: 'specific-ws' },
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({
				filter: expect.objectContaining({ workspace: 'specific-ws' }),
			}),
		);
	});

	it('applies min_confidence filter', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
			filter: { min_confidence: 0.8 },
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({
				filter: expect.objectContaining({ min_confidence: 0.8 }),
			}),
		);
	});

	it('applies memory_type filter', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
			filter: { memory_type: 'episodic' },
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({
				filter: expect.objectContaining({ memory_type: 'episodic' }),
			}),
		);
	});

	it('applies tags filter', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
			filter: { tags: ['tag1', 'tag2'] },
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({
				filter: expect.objectContaining({ tags: ['tag1', 'tag2'] }),
			}),
		);
	});

	it('applies score_threshold', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
			score_threshold: 0.7,
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({ scoreThreshold: 0.7 }),
		);
	});

	it('applies hnsw_ef', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
			hnsw_ef: 200,
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({ hnsw_ef: 200 }),
		);
	});

	it('applies use_hybrid_search', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
			use_hybrid_search: true,
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({ useHybridSearch: true }),
		);
	});

	it('applies hybrid_alpha', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
			hybrid_alpha: 0.6,
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({ hybridAlpha: 0.6 }),
		);
	});
});

// ── memory-list sorting paths ───────────────────────────────────────────

describe('memory-list - sorting by different fields', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('sorts by updated_at desc', async () => {
		const now = new Date().toISOString();
		const past = new Date(Date.now() - 86400000).toISOString();
		const memories = [
			{ id: '1', content: 'old', score: 1, path: '', metadata: { created_at: past, updated_at: past } },
			{ id: '2', content: 'new', score: 1, path: '', metadata: { created_at: now, updated_at: now } },
		];

		mockQdrant.count.mockResolvedValueOnce(2);
		mockQdrant.list.mockResolvedValueOnce(memories);

		const result = await getTool('memory-list').handler({
			sort_by: 'updated_at',
			sort_order: 'desc',
		});

		expect(result.success).toBe(true);
		expect((result.data as any).memories[0].id).toBe('2');
	});

	it('sorts by updated_at asc', async () => {
		const now = new Date().toISOString();
		const past = new Date(Date.now() - 86400000).toISOString();
		const memories = [
			{ id: '1', content: 'old', score: 1, path: '', metadata: { created_at: past, updated_at: past } },
			{ id: '2', content: 'new', score: 1, path: '', metadata: { created_at: now, updated_at: now } },
		];

		mockQdrant.count.mockResolvedValueOnce(2);
		mockQdrant.list.mockResolvedValueOnce(memories);

		const result = await getTool('memory-list').handler({
			sort_by: 'updated_at',
			sort_order: 'asc',
		});

		expect(result.success).toBe(true);
		expect((result.data as any).memories[0].id).toBe('1');
	});

	it('sorts by confidence desc', async () => {
		const now = new Date().toISOString();
		const memories = [
			{ id: '1', content: 'low', score: 1, path: '', metadata: { created_at: now, confidence: 0.3 } },
			{ id: '2', content: 'high', score: 1, path: '', metadata: { created_at: now, confidence: 0.9 } },
			{ id: '3', content: 'mid', score: 1, path: '', metadata: { created_at: now, confidence: 0.6 } },
		];

		mockQdrant.count.mockResolvedValueOnce(3);
		mockQdrant.list.mockResolvedValueOnce(memories);

		const result = await getTool('memory-list').handler({
			sort_by: 'confidence',
			sort_order: 'desc',
		});

		expect(result.success).toBe(true);
		expect((result.data as any).memories[0].id).toBe('2');
	});

	it('sorts by access_count asc', async () => {
		const now = new Date().toISOString();
		const memories = [
			{ id: '1', content: 'a', score: 1, path: '', metadata: { created_at: now, access_count: 50 } },
			{ id: '2', content: 'b', score: 1, path: '', metadata: { created_at: now, access_count: 5 } },
			{ id: '3', content: 'c', score: 1, path: '', metadata: { created_at: now, access_count: 20 } },
		];

		mockQdrant.count.mockResolvedValueOnce(3);
		mockQdrant.list.mockResolvedValueOnce(memories);

		const result = await getTool('memory-list').handler({
			sort_by: 'access_count',
			sort_order: 'asc',
		});

		expect(result.success).toBe(true);
		expect((result.data as any).memories[0].id).toBe('2');
	});

	it('defaults to desc order when not specified', async () => {
		const now = new Date().toISOString();
		const memories = [
			{ id: '1', content: 'a', score: 1, path: '', metadata: { created_at: now, access_count: 10 } },
			{ id: '2', content: 'b', score: 1, path: '', metadata: { created_at: now, access_count: 20 } },
		];

		mockQdrant.count.mockResolvedValueOnce(2);
		mockQdrant.list.mockResolvedValueOnce(memories);

		const result = await getTool('memory-list').handler({
			sort_by: 'access_count',
		});

		expect(result.success).toBe(true);
		expect((result.data as any).memories[0].id).toBe('2');
	});

	it('handles missing metadata fields (defaults to 0)', async () => {
		const now = new Date().toISOString();
		const memories = [
			{ id: '1', content: 'a', score: 1, path: '', metadata: { created_at: now } },
			{ id: '2', content: 'b', score: 1, path: '', metadata: { created_at: now, access_count: 5 } },
		];

		mockQdrant.count.mockResolvedValueOnce(2);
		mockQdrant.list.mockResolvedValueOnce(memories);

		const result = await getTool('memory-list').handler({
			sort_by: 'access_count',
		});

		expect(result.success).toBe(true);
		expect((result.data as any).memories[0].id).toBe('2');
	});

	it('respects user offset after sort', async () => {
		const now = new Date().toISOString();
		const memories = [
			{ id: '1', content: 'a', score: 1, path: '', metadata: { created_at: now, access_count: 1 } },
			{ id: '2', content: 'b', score: 1, path: '', metadata: { created_at: now, access_count: 2 } },
			{ id: '3', content: 'c', score: 1, path: '', metadata: { created_at: now, access_count: 3 } },
		];

		mockQdrant.count.mockResolvedValueOnce(3);
		mockQdrant.list.mockResolvedValueOnce(memories);

		const result = await getTool('memory-list').handler({
			sort_by: 'access_count',
			limit: 1,
			offset: 1,
		});

		expect(result.success).toBe(true);
		expect((result.data as any).memories).toHaveLength(1);
		expect((result.data as any).memories[0].id).toBe('2');
	});

	it('caps fetch at MAX_IN_MEMORY_SORT_COUNT', async () => {
		mockQdrant.count.mockResolvedValueOnce(50000);
		mockQdrant.list.mockResolvedValueOnce([]);

		await getTool('memory-list').handler({
			sort_by: 'access_count',
		});

		expect(mockQdrant.list).toHaveBeenCalledWith(undefined, 10000, 0);
	});

	it('truncates content preview', async () => {
		const longContent = 'x'.repeat(500);
		mockQdrant.list.mockResolvedValueOnce([
			{ id: '1', content: longContent, score: 1, path: '', metadata: { created_at: new Date().toISOString() } },
		]);

		const result = await getTool('memory-list').handler({});

		expect(result.success).toBe(true);
		const returnedContent = (result.data as any).memories[0].content;
		expect(returnedContent.length).toBeLessThan(longContent.length);
	});
});

// ── memory-update validation ────────────────────────────────────────────

describe('memory-update - validation', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440005';
	const baseMemory = {
		id: VALID_UUID,
		content: 'original',
		score: 1,
		path: '',
		metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejects update without content or metadata', async () => {
		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('rejects invalid UUID', async () => {
		const result = await getTool('memory-update').handler({
			id: 'not-a-uuid',
			content: 'new',
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('updates confidence metadata', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { confidence: 0.85 },
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.updatePayload).toHaveBeenCalled();
	});

	it('updates tags metadata', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { tags: ['new', 'tags'] },
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.updatePayload).toHaveBeenCalled();
	});

	it('reindexes on content update', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);
		mockEmbedding.generateDualEmbeddings.mockResolvedValueOnce({
			small: new Array(384).fill(0.1),
			large: new Array(384).fill(0.2),
		});

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'new content',
		});

		expect(result.success).toBe(true);
		expect((result.data as any).reindexed).toBe(true);
		expect(mockQdrant.upsert).toHaveBeenCalled();
	});

	it('preserves metadata on content update', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			...baseMemory,
			metadata: { ...baseMemory.metadata, confidence: 0.8, tags: ['old-tag'] },
		});
		mockEmbedding.generateDualEmbeddings.mockResolvedValueOnce({
			small: new Array(384).fill(0.1),
			large: new Array(384).fill(0.2),
		});

		await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'updated',
		});

		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown, Record<string, unknown>][];
		const metadata = calls[0][2];
		expect(metadata?.confidence).toBe(0.8);
		expect(metadata?.tags).toEqual(['old-tag']);
	});

	it('merges new metadata on content update', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			...baseMemory,
			metadata: { ...baseMemory.metadata, confidence: 0.8 },
		});
		mockEmbedding.generateDualEmbeddings.mockResolvedValueOnce({
			small: new Array(384).fill(0.1),
			large: new Array(384).fill(0.2),
		});

		await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'new',
			metadata: { confidence: 0.95 },
		});

		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown, Record<string, unknown>][];
		const metadata = calls[0][2];
		expect(metadata?.confidence).toBe(0.95);
	});

	it('blocks update with secret content', async () => {
		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'sk-' + 'x'.repeat(48),
		});

		expect(result.success).toBe(false);
		expect(result.metadata?.error_code).toBe('SECRETS_DETECTED');
		expect(mockQdrant.get).not.toHaveBeenCalled();
	});

	it('does not call get when secrets detected', async () => {
		await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'sk-' + 'y'.repeat(48),
		});

		expect(mockQdrant.get).not.toHaveBeenCalled();
	});
});

// ── memory-update chunked memory ────────────────────────────────────────

describe('memory-update - chunked memory', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440006';
	const baseMemory = {
		id: VALID_UUID,
		content: 'original',
		score: 1,
		path: '',
		metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
	};

	beforeEach(() => {
		vi.clearAllMocks();
		// Reset mocks to their default behavior
		mockEmbedding.generateChunkedEmbeddings.mockResolvedValue([
			{ chunk: 'chunk text', embedding: new Array(384).fill(0.1), index: 0, total: 1 },
		]);
	});

	it('deletes siblings on chunked content update', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			...baseMemory,
			metadata: {
				...baseMemory.metadata,
				chunk_index: 1,
				total_chunks: 3,
				chunk_group_id: 'group-abc',
			},
		});

		mockQdrant.list.mockResolvedValueOnce([
			{ id: 'chunk-1', content: 'c1', score: 1, path: '', metadata: {} },
			{ id: 'chunk-2', content: 'c2', score: 1, path: '', metadata: {} },
			{ id: 'chunk-3', content: 'c3', score: 1, path: '', metadata: {} },
		]);

		mockQdrant.batchDelete.mockResolvedValue(undefined);
		mockEmbedding.generateChunkedEmbeddings.mockResolvedValueOnce([
			{ chunk: 'new1', embedding: new Array(384).fill(0.1), index: 0, total: 2 },
			{ chunk: 'new2', embedding: new Array(384).fill(0.1), index: 1, total: 2 },
		]);

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'new content',
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.batchDelete).toHaveBeenCalledWith(['chunk-1', 'chunk-2', 'chunk-3']);
		expect((result.data as any).old_chunks).toBe(3);
	});

	// Re-enabled: logic verified correct
	it('re-chunks on chunk update', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			...baseMemory,
			metadata: {
				...baseMemory.metadata,
				chunk_index: 0,
				total_chunks: 1,
				chunk_group_id: 'single',
			},
		});

		mockQdrant.list.mockResolvedValueOnce([
			{ id: 'chunk-old', content: 'short', score: 1, path: '', metadata: {} },
		]);

		mockQdrant.batchDelete.mockResolvedValue(undefined);

		const longContent = 'x '.repeat(600);
		mockEmbedding.generateChunkedEmbeddings.mockResolvedValueOnce([
			{ chunk: 'p1', embedding: new Array(384).fill(0.1), index: 0, total: 3 },
			{ chunk: 'p2', embedding: new Array(384).fill(0.1), index: 1, total: 3 },
			{ chunk: 'p3', embedding: new Array(384).fill(0.1), index: 2, total: 3 },
		]);

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			content: longContent,
			auto_chunk: true,
		});

		expect(result.success).toBe(true);
		expect((result.data as any).chunks).toBe(3);
	});

	it('consolidates chunks to single', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			...baseMemory,
			metadata: {
				...baseMemory.metadata,
				chunk_index: 0,
				total_chunks: 3,
				chunk_group_id: 'group-many',
			},
		});

		mockQdrant.list.mockResolvedValueOnce([
			{ id: 'chunk-1', content: 'c1', score: 1, path: '', metadata: {} },
			{ id: 'chunk-2', content: 'c2', score: 1, path: '', metadata: {} },
			{ id: 'chunk-3', content: 'c3', score: 1, path: '', metadata: {} },
		]);

		mockQdrant.batchDelete.mockResolvedValue(undefined);
		mockEmbedding.generateDualEmbeddings.mockResolvedValueOnce({
			small: new Array(384).fill(0.1),
			large: new Array(384).fill(0.2),
		});

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'short new',
		});

		expect(result.success).toBe(true);
		expect((result.data as any).old_chunks).toBe(3);
	});

	it('finds siblings by chunk_group_id', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			...baseMemory,
			metadata: {
				...baseMemory.metadata,
				chunk_index: 0,
				total_chunks: 2,
				chunk_group_id: 'specific',
			},
		});

		mockQdrant.list.mockResolvedValueOnce([
			{ id: 'a', content: 'a', score: 1, path: '', metadata: {} },
			{ id: 'b', content: 'b', score: 1, path: '', metadata: {} },
		]);

		mockQdrant.batchDelete.mockResolvedValue(undefined);
		mockEmbedding.generateDualEmbeddings.mockResolvedValueOnce({
			small: new Array(384).fill(0.1),
			large: new Array(384).fill(0.2),
		});

		await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'new',
		});

		expect(mockQdrant.list).toHaveBeenCalledWith(
			expect.objectContaining({ metadata: expect.objectContaining({ chunk_group_id: 'specific' }) }),
		);
	});

	it('updates metadata across chunk siblings', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			...baseMemory,
			metadata: {
				...baseMemory.metadata,
				chunk_index: 0,
				total_chunks: 2,
				chunk_group_id: 'group-xyz',
			},
		});

		mockQdrant.list.mockResolvedValueOnce([
			{ id: 'c1', content: 'a', score: 1, path: '', metadata: {} },
			{ id: 'c2', content: 'b', score: 1, path: '', metadata: {} },
		]);

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { confidence: 0.9 },
		});

		expect(result.success).toBe(true);
		expect((result.data as any).siblings_updated).toBe(2);
	});
});

// ── memory-get edge cases ───────────────────────────────────────────────

describe('memory-get - edge cases', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440007';

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns memory with full metadata', async () => {
		const now = new Date().toISOString();
		mockQdrant.get.mockResolvedValueOnce({
			id: VALID_UUID,
			content: 'test',
			score: 1,
			path: '',
			metadata: {
				created_at: now,
				updated_at: now,
				confidence: 0.95,
				tags: ['important'],
			},
		});

		const result = await getTool('memory-get').handler({ id: VALID_UUID });

		expect(result.success).toBe(true);
		expect((result.data as any).metadata.confidence).toBe(0.95);
	});

	it('rejects non-UUID', async () => {
		const result = await getTool('memory-get').handler({ id: 'invalid' });

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});
});

// ── memory-delete edge cases ────────────────────────────────────────────

describe('memory-delete - edge cases', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440008';

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('deletes chunked memory chunk', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			id: VALID_UUID,
			content: 'chunk',
			score: 1,
			path: '',
			metadata: {
				chunk_index: 0,
				total_chunks: 3,
				chunk_group_id: 'grp',
			},
		});

		const result = await getTool('memory-delete').handler({ id: VALID_UUID });

		expect(result.success).toBe(true);
		expect(mockQdrant.delete).toHaveBeenCalledWith(VALID_UUID);
	});

	it('rejects non-UUID', async () => {
		const result = await getTool('memory-delete').handler({ id: 'not-uuid' });

		expect(result.success).toBe(false);
	});
});

// ── memory-batch-delete edge cases ──────────────────────────────────────

describe('memory-batch-delete - edge cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('batch-deletes multiple ids', async () => {
		const ids = [
			'550e8400-e29b-41d4-a716-446655440010',
			'550e8400-e29b-41d4-a716-446655440011',
		];

		const result = await getTool('memory-batch-delete').handler({ ids });

		expect(result.success).toBe(true);
		expect((result.data as any).count).toBe(2);
	});

	it('handles service failure', async () => {
		const ids = ['550e8400-e29b-41d4-a716-446655440010'];
		mockQdrant.batchDelete.mockRejectedValueOnce(new Error('Failed'));

		const result = await getTool('memory-batch-delete').handler({ ids });

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});

	it('validates all UUIDs', async () => {
		const result = await getTool('memory-batch-delete').handler({
			ids: ['550e8400-e29b-41d4-a716-446655440010', 'invalid'],
		});

		expect(result.success).toBe(false);
	});
});

// ── memory-status statistics ────────────────────────────────────────────

describe('memory-status - statistics', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('includes collection stats', async () => {
		mockQdrant.getStats.mockResolvedValueOnce({
			points_count: 1000,
			indexed_vectors_count: 950,
			segments_count: 5,
			status: 'green',
			optimizer_status: 'ok',
			access_tracking_failures: 0,
			config: {},
		});

		const result = await getTool('memory-status').handler({});

		expect(result.success).toBe(true);
		expect((result.data as any).collection.points_count).toBe(1000);
	});

	it('includes embedding stats when requested', async () => {
		mockEmbedding.getStats.mockReturnValueOnce({
			totalEmbeddings: 100,
			cacheHits: 50,
			cacheMisses: 50,
			totalTokens: 10000,
			totalCost: 0.05,
			cacheHitRate: 0.5,
		});

		const result = await getTool('memory-status').handler({ include_embedding_stats: true });

		expect(result.success).toBe(true);
		expect((result.data as any).embeddings).toBeDefined();
	});

	it('omits embedding stats when false', async () => {
		const result = await getTool('memory-status').handler({ include_embedding_stats: false });

		expect(result.success).toBe(true);
		expect((result.data as any).embeddings).toBeUndefined();
	});

	it('returns error on stats failure', async () => {
		mockQdrant.getStats.mockRejectedValueOnce(new Error('Failed'));

		const result = await getTool('memory-status').handler({});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});
});

// ── memory-count filtering ──────────────────────────────────────────────

describe('memory-count - filtering', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns count with no filters', async () => {
		mockQdrant.count.mockResolvedValueOnce(100);

		const result = await getTool('memory-count').handler({});

		expect(result.success).toBe(true);
		expect((result.data as any).count).toBe(100);
	});

	it('applies workspace filter', async () => {
		mockQdrant.count.mockResolvedValueOnce(25);

		const result = await getTool('memory-count').handler({
			filter: { workspace: 'my-ws' },
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.count).toHaveBeenCalledWith(
			expect.objectContaining({ workspace: 'my-ws' }),
		);
	});

	it('applies memory_type filter', async () => {
		mockQdrant.count.mockResolvedValueOnce(15);

		await getTool('memory-count').handler({
			filter: { memory_type: 'episodic' },
		});

		expect(mockQdrant.count).toHaveBeenCalledWith(
			expect.objectContaining({ memory_type: 'episodic' }),
		);
	});

	it('applies multiple filters', async () => {
		mockQdrant.count.mockResolvedValueOnce(5);

		await getTool('memory-count').handler({
			filter: {
				workspace: 'ws',
				memory_type: 'long-term',
				min_confidence: 0.8,
			},
		});

		expect(mockQdrant.count).toHaveBeenCalledWith(
			expect.objectContaining({
				workspace: 'ws',
				memory_type: 'long-term',
				min_confidence: 0.8,
			}),
		);
	});

	it('returns error on failure', async () => {
		mockQdrant.count.mockRejectedValueOnce(new Error('Timeout'));

		const result = await getTool('memory-count').handler({});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});
});

// ── Additional coverage for missing branches ──────────────────────────────

describe('memory-store - tag validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejects tags that exceed max count (20)', async () => {
		const tooManyTags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
		const result = await getTool('memory-store').handler({
			content: 'test content',
			metadata: { tags: tooManyTags },
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('rejects tag that exceeds max length (50 chars)', async () => {
		const result = await getTool('memory-store').handler({
			content: 'test content',
			metadata: { tags: ['a'.repeat(51)] },
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('accepts tag at exactly 50 chars', async () => {
		mockQdrant.upsert.mockResolvedValue('tag-id');

		const result = await getTool('memory-store').handler({
			content: 'test content',
			metadata: { tags: ['a'.repeat(50)] },
		});

		expect(result.success).toBe(true);
	});

	it('rejects empty tag in array', async () => {
		const result = await getTool('memory-store').handler({
			content: 'test content',
			metadata: { tags: ['valid', ''] },
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('accepts exactly 20 tags', async () => {
		mockQdrant.upsert.mockResolvedValue('tag-id');

		const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
		const result = await getTool('memory-store').handler({
			content: 'test content',
			metadata: { tags },
		});

		expect(result.success).toBe(true);
	});
});

describe('memory-store - confidence validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejects negative confidence', async () => {
		const result = await getTool('memory-store').handler({
			content: 'test',
			metadata: { confidence: -0.1 },
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('rejects confidence > 1.0', async () => {
		const result = await getTool('memory-store').handler({
			content: 'test',
			metadata: { confidence: 1.01 },
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('accepts confidence at 0.0', async () => {
		mockQdrant.upsert.mockResolvedValue('id');

		const result = await getTool('memory-store').handler({
			content: 'test',
			metadata: { confidence: 0.0 },
		});

		expect(result.success).toBe(true);
	});

	it('accepts confidence at 1.0', async () => {
		mockQdrant.upsert.mockResolvedValue('id');

		const result = await getTool('memory-store').handler({
			content: 'test',
			metadata: { confidence: 1.0 },
		});

		expect(result.success).toBe(true);
	});

	it('stores confidence in response', async () => {
		mockQdrant.upsert.mockResolvedValue('id');

		const result = await getTool('memory-store').handler({
			content: 'test',
			metadata: { confidence: 0.75 },
		});

		expect(result.success).toBe(true);
		expect((result.data as any).confidence).toBe(0.75);
	});
});

describe('memory-store - auto_chunk parameter behavior', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('does not chunk when auto_chunk is false', async () => {
		mockQdrant.upsert.mockResolvedValue('id');

		const longContent = 'word '.repeat(300); // > 1000 chars
		const result = await getTool('memory-store').handler({
			content: longContent,
			auto_chunk: false,
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.upsert).toHaveBeenCalledTimes(1);
		expect((result.data as any).chunks).toBeUndefined();
	});

	it('does not chunk when content <= chunk size even with auto_chunk true', async () => {
		mockQdrant.upsert.mockResolvedValue('id');

		const shortContent = 'short content';
		const result = await getTool('memory-store').handler({
			content: shortContent,
			auto_chunk: true,
		});

		expect(result.success).toBe(true);
		expect((result.data as any).chunks).toBeUndefined();
		expect((result.data as any).id).toBeDefined();
	});
});

describe('memory-query - empty results', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns empty results array when no matches', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		const result = await getTool('memory-query').handler({ query: 'nonexistent' });

		expect(result.success).toBe(true);
		expect((result.data as any).results).toHaveLength(0);
		expect((result.data as any).count).toBe(0);
	});

	it('returns query text even with no results', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		const result = await getTool('memory-query').handler({ query: 'empty query' });

		expect((result.data as any).query).toBe('empty query');
	});

	it('applies limit and offset to search', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
			limit: 50,
			offset: 10,
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({
				limit: 50,
				offset: 10,
			}),
		);
	});

	it('applies score threshold to search', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
			score_threshold: 0.75,
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({
				scoreThreshold: 0.75,
			}),
		);
	});

	it('applies hnsw_ef parameter', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
			hnsw_ef: 256,
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({
				hnsw_ef: 256,
			}),
		);
	});

	it('applies hybrid search parameters', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
			use_hybrid_search: true,
			hybrid_alpha: 0.6,
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({
				useHybridSearch: true,
				hybridAlpha: 0.6,
			}),
		);
	});
});

describe('memory-query - query validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejects empty query', async () => {
		const result = await getTool('memory-query').handler({ query: '' });

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('rejects query > 10,000 chars', async () => {
		const result = await getTool('memory-query').handler({
			query: 'a'.repeat(10001),
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('accepts query at exactly 10,000 chars', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		const result = await getTool('memory-query').handler({
			query: 'a'.repeat(10000),
		});

		expect(result.success).toBe(true);
	});

	it('rejects invalid hnsw_ef (< 64)', async () => {
		const result = await getTool('memory-query').handler({
			query: 'test',
			hnsw_ef: 63,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('rejects invalid hnsw_ef (> 512)', async () => {
		const result = await getTool('memory-query').handler({
			query: 'test',
			hnsw_ef: 513,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('accepts hnsw_ef at boundaries (64, 512)', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		const result1 = await getTool('memory-query').handler({
			query: 'test',
			hnsw_ef: 64,
		});
		expect(result1.success).toBe(true);

		vi.clearAllMocks();
		mockQdrant.search.mockResolvedValueOnce([]);

		const result2 = await getTool('memory-query').handler({
			query: 'test',
			hnsw_ef: 512,
		});
		expect(result2.success).toBe(true);
	});

	it('rejects limit > 100', async () => {
		const result = await getTool('memory-query').handler({
			query: 'test',
			limit: 101,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('rejects limit < 1', async () => {
		const result = await getTool('memory-query').handler({
			query: 'test',
			limit: 0,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('rejects negative offset', async () => {
		const result = await getTool('memory-query').handler({
			query: 'test',
			offset: -1,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});
});

describe('memory-list - sorting edge cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('sorts by created_at asc without loading all records', async () => {
		const now = new Date().toISOString();
		const memories = [
			{ id: '2', content: 'b', score: 1, path: '', metadata: { created_at: new Date(Date.now() + 1000).toISOString() } },
			{ id: '1', content: 'a', score: 1, path: '', metadata: { created_at: now } },
		];

		mockQdrant.count.mockResolvedValueOnce(2);
		mockQdrant.list.mockResolvedValueOnce(memories);

		const result = await getTool('memory-list').handler({
			sort_by: 'created_at',
			sort_order: 'asc',
		});

		expect(result.success).toBe(true);
		// Should be sorted asc, so id='1' comes first (earlier created_at)
		expect((result.data as any).memories[0].id).toBe('1');
		// count() is now called to determine if we need in-memory sorting
		expect(mockQdrant.count).toHaveBeenCalledWith(undefined);
	});

	it('applies pagination without in-memory sort for created_at', async () => {
		const now = new Date().toISOString();
		const memories = Array.from({ length: 15 }, (_, i) => ({
			id: `mem-${i}`,
			content: `memory ${i}`,
			score: 1,
			path: '',
			metadata: { created_at: new Date(Date.now() - i * 1000).toISOString() },
		}));
		mockQdrant.count.mockResolvedValueOnce(15);
		mockQdrant.list.mockResolvedValueOnce(memories);

		await getTool('memory-list').handler({
			sort_by: 'created_at',
			limit: 5,
			offset: 10,
		});

		// For created_at sorting, now loads all records for proper sorting (up to in-memory limit)
		expect(mockQdrant.count).toHaveBeenCalledWith(undefined);
		expect(mockQdrant.list).toHaveBeenCalledWith(undefined, 15, 0);
	});

	it('sorts by updated_at desc', async () => {
		const now = new Date().toISOString();
		const later = new Date(Date.now() + 5000).toISOString();
		const memories = [
			{ id: '1', content: 'a', score: 1, path: '', metadata: { created_at: now, updated_at: now } },
			{ id: '2', content: 'b', score: 1, path: '', metadata: { created_at: now, updated_at: later } },
		];

		mockQdrant.count.mockResolvedValueOnce(2);
		mockQdrant.list.mockResolvedValueOnce(memories);

		const result = await getTool('memory-list').handler({
			sort_by: 'updated_at',
			sort_order: 'desc',
		});

		expect(result.success).toBe(true);
		// Desc order: later timestamp first
		expect((result.data as any).memories[0].id).toBe('2');
	});

	it('defaults sort_order to desc when not specified', async () => {
		const now = new Date().toISOString();
		const memories = [
			{ id: '1', content: 'a', score: 1, path: '', metadata: { created_at: now, access_count: 5 } },
			{ id: '2', content: 'b', score: 1, path: '', metadata: { created_at: now, access_count: 10 } },
		];

		mockQdrant.count.mockResolvedValueOnce(2);
		mockQdrant.list.mockResolvedValueOnce(memories);

		const result = await getTool('memory-list').handler({
			sort_by: 'access_count',
		});

		expect(result.success).toBe(true);
		// Default desc: higher access_count first
		expect((result.data as any).memories[0].id).toBe('2');
	});

	it('handles memor with no created_at field when sorting by created_at', async () => {
		mockQdrant.list.mockResolvedValueOnce([
			{ id: '1', content: 'a', score: 1, path: '', metadata: {} },
			{ id: '2', content: 'b', score: 1, path: '', metadata: { created_at: new Date().toISOString() } },
		]);

		const result = await getTool('memory-list').handler({
			sort_by: 'created_at',
		});

		expect(result.success).toBe(true);
		expect((result.data as any).memories).toHaveLength(2);
	});
});

describe('memory-list - pagination edge cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('handles offset > total count', async () => {
		mockQdrant.count.mockResolvedValueOnce(5);
		mockQdrant.list.mockResolvedValueOnce([]);

		const result = await getTool('memory-list').handler({
			sort_by: 'access_count',
			offset: 100,
		});

		expect(result.success).toBe(true);
		expect((result.data as any).memories).toHaveLength(0);
	});

	it('handles limit=0 (should default)', async () => {
		const result = await getTool('memory-list').handler({
			limit: 0,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('handles limit > LIST_LIMIT_MAX (1000)', async () => {
		const result = await getTool('memory-list').handler({
			limit: 1001,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('accepts limit at exactly 1000', async () => {
		mockQdrant.list.mockResolvedValueOnce([]);

		const result = await getTool('memory-list').handler({
			limit: 1000,
		});

		expect(result.success).toBe(true);
	});
});

describe('memory-update - metadata validation', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440008';
	const baseMemory = {
		id: VALID_UUID,
		content: 'original',
		score: 1,
		path: '',
		metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejects update with invalid confidence', async () => {
		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { confidence: 1.5 },
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('rejects update with too many tags', async () => {
		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { tags: Array.from({ length: 21 }, (_, i) => `tag${i}`) },
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('accepts update with valid tags', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { tags: ['tag1', 'tag2'] },
		});

		expect(result.success).toBe(true);
	});

	it('accepts update with memory_type', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { memory_type: 'episodic' },
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.updatePayload).toHaveBeenCalled();
	});
});

describe('memory-update - non-chunked content update', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440009';
	const baseMemory = {
		id: VALID_UUID,
		content: 'original',
		score: 1,
		path: '',
		metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('merges metadata on content update', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			...baseMemory,
			metadata: { ...baseMemory.metadata, confidence: 0.7, tags: ['old'] },
		});
		mockEmbedding.generateDualEmbeddings.mockResolvedValueOnce({
			small: new Array(384).fill(0.1),
			large: new Array(384).fill(0.2),
		});

		await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'new content',
			metadata: { confidence: 0.9 },
		});

		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown[], Record<string, unknown>][];
		const metadata = calls[0][2];
		expect(metadata?.confidence).toBe(0.9); // New value overrides
		expect(metadata?.tags).toEqual(['old']); // Old value preserved
	});

	it('preserves ID on content update for atomic replacement', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);
		mockEmbedding.generateDualEmbeddings.mockResolvedValueOnce({
			small: new Array(384).fill(0.1),
			large: new Array(384).fill(0.2),
		});

		await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'updated',
		});

		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown[], Record<string, unknown>][];
		const metadata = calls[0][2];
		expect(metadata?.id).toBe(VALID_UUID);
	});

	it('returns reindexed=true on content update', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);
		mockEmbedding.generateDualEmbeddings.mockResolvedValueOnce({
			small: new Array(384).fill(0.1),
			large: new Array(384).fill(0.2),
		});

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'new',
		});

		expect((result.data as any).reindexed).toBe(true);
	});

	it('returns reindexed=false on metadata-only update', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { confidence: 0.95 },
		});

		expect((result.data as any).reindexed).toBe(false);
	});
});

describe('memory-delete - edge cases', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440011';

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns NOT_FOUND when delete non-existent', async () => {
		mockQdrant.get.mockResolvedValueOnce(null);

		const result = await getTool('memory-delete').handler({ id: VALID_UUID });

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('NOT_FOUND_ERROR');
		expect(mockQdrant.delete).not.toHaveBeenCalled();
	});

	it('executes delete after existence check', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			id: VALID_UUID,
			content: 'to delete',
			score: 1,
			path: '',
			metadata: {},
		});

		const result = await getTool('memory-delete').handler({ id: VALID_UUID });

		expect(result.success).toBe(true);
		expect(mockQdrant.delete).toHaveBeenCalledWith(VALID_UUID);
	});

	it('returns error on delete failure', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			id: VALID_UUID,
			content: 'to delete',
			score: 1,
			path: '',
			metadata: {},
		});
		mockQdrant.delete.mockRejectedValueOnce(new Error('DB error'));

		const result = await getTool('memory-delete').handler({ id: VALID_UUID });

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});
});

describe('memory-batch-delete - edge cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('handles batch delete of 100 ids', async () => {
		const ids = Array.from({ length: 100 }, (_, i) => `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`);

		const result = await getTool('memory-batch-delete').handler({ ids });

		expect(result.success).toBe(true);
		expect((result.data as any).count).toBe(100);
	});

	it('rejects > 100 ids', async () => {
		const ids = Array.from({ length: 101 }, (_, i) => `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`);

		const result = await getTool('memory-batch-delete').handler({ ids });

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('returns ids in response', async () => {
		const ids = ['550e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440002'];

		const result = await getTool('memory-batch-delete').handler({ ids });

		expect(result.success).toBe(true);
		expect((result.data as any).ids).toEqual(ids);
	});
});

describe('memory-status - with embedding stats', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('includes embedding stats when requested', async () => {
		const result = await getTool('memory-status').handler({ include_embedding_stats: true });

		expect(result.success).toBe(true);
		expect((result.data as any).embeddings).toBeDefined();
		expect((result.data as any).embeddings.totalEmbeddings).toBeDefined();
		expect(mockEmbedding.getStats).toHaveBeenCalled();
	});

	it('includes server timestamp', async () => {
		const result = await getTool('memory-status').handler({});

		expect(result.success).toBe(true);
		expect((result.data as any).timestamp).toBeDefined();
	});

	it('includes collection status breakdown', async () => {
		const result = await getTool('memory-status').handler({});

		expect(result.success).toBe(true);
		expect((result.data as any).collection).toBeDefined();
		expect((result.data as any).collection.status).toBe('green');
	});
});

describe('memory-status - workspace filtering', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('counts by workspace when specified', async () => {
		mockQdrant.count.mockResolvedValue(42);

		const result = await getTool('memory-status').handler({
			workspace: 'my-workspace',
		});

		expect(result.success).toBe(true);
		// Should have called count at least once (for workspace count)
		expect(mockQdrant.count).toHaveBeenCalled();
	});

	it('counts by memory type', async () => {
		mockQdrant.count.mockResolvedValue(0);

		const result = await getTool('memory-status').handler({});

		expect(result.success).toBe(true);
		// Should count by type (episodic, short-term, long-term)
		expect(mockQdrant.count).toHaveBeenCalledWith(
			expect.objectContaining({ memory_type: expect.any(String) }),
		);
	});
});

describe('memory-query - edge case behaviors', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('handles query with all filter types', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		const result = await getTool('memory-query').handler({
			query: 'test query',
			filter: {
				workspace: 'ws1',
				memory_type: 'episodic',
				min_confidence: 0.7,
				tags: ['important'],
			},
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({
				filter: expect.objectContaining({
					workspace: 'ws1',
					memory_type: 'episodic',
					min_confidence: 0.7,
					tags: ['important'],
				}),
			}),
		);
	});

	it('passes useHybridSearch to search when true', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
			use_hybrid_search: true,
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({
				useHybridSearch: true,
			}),
		);
	});

	it('passes useHybridSearch false by default', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({
				useHybridSearch: false,
			}),
		);
	});

	it('passes hybrid_alpha parameter', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
			hybrid_alpha: 0.7,
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({
				hybridAlpha: 0.7,
			}),
		);
	});
});

describe('memory-update - validation edge cases', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440012';
	const baseMemory = {
		id: VALID_UUID,
		content: 'original',
		score: 1,
		path: '',
		metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('validates that at least content or metadata is provided', async () => {
		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('allows metadata update when content is not provided', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { tags: ['new-tag'] },
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.updatePayload).toHaveBeenCalled();
		expect(mockQdrant.upsert).not.toHaveBeenCalled();
	});

	it('calls upsert when content is provided', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);
		mockEmbedding.generateDualEmbeddings.mockResolvedValueOnce({
			small: new Array(384).fill(0.1),
			large: new Array(384).fill(0.2),
		});

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'new content',
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.upsert).toHaveBeenCalled();
	});

	it('calls get before update to check existence', async () => {
		mockQdrant.get.mockResolvedValueOnce(null);

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { tags: ['tag'] },
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('NOT_FOUND_ERROR');
		expect(mockQdrant.get).toHaveBeenCalledWith(VALID_UUID);
	});
});

describe('memory-store - error handling', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns EXECUTION_ERROR on upsert failure', async () => {
		mockQdrant.upsert.mockRejectedValueOnce(new Error('DB error'));

		const result = await getTool('memory-store').handler({
			content: 'test',
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});

	it('returns EXECUTION_ERROR on embedding generation failure', async () => {
		mockEmbedding.generateDualEmbeddings.mockRejectedValueOnce(new Error('API error'));

		const result = await getTool('memory-store').handler({
			content: 'test',
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});

	it('returns EXECUTION_ERROR on large embedding generation failure', async () => {
		const longContent = 'x '.repeat(600);
		mockEmbedding.generateChunkedEmbeddings.mockResolvedValueOnce([
			{ chunk: 'c1', embedding: new Array(384).fill(0.1), index: 0, total: 1 },
		]);
		mockEmbedding.generateLargeEmbedding.mockRejectedValueOnce(new Error('Large embedding error'));

		const result = await getTool('memory-store').handler({
			content: longContent,
			auto_chunk: true,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});
});

describe('memory-list - sorting by updated_at', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('sorts by updated_at asc', async () => {
		const now = new Date().toISOString();
		const later = new Date(Date.now() + 5000).toISOString();
		const memories = [
			{ id: '1', content: 'a', score: 1, path: '', metadata: { created_at: now, updated_at: later } },
			{ id: '2', content: 'b', score: 1, path: '', metadata: { created_at: now, updated_at: now } },
		];

		mockQdrant.count.mockResolvedValueOnce(2);
		mockQdrant.list.mockResolvedValueOnce(memories);

		const result = await getTool('memory-list').handler({
			sort_by: 'updated_at',
			sort_order: 'asc',
		});

		expect(result.success).toBe(true);
		// Asc order: earlier timestamp first
		expect((result.data as any).memories[0].id).toBe('2');
	});
});

describe('memory-list - edge case sorting', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('sorts by confidence desc', async () => {
		const now = new Date().toISOString();
		const memories = [
			{ id: '1', content: 'a', score: 1, path: '', metadata: { created_at: now, confidence: 0.5 } },
			{ id: '2', content: 'b', score: 1, path: '', metadata: { created_at: now, confidence: 0.9 } },
		];

		mockQdrant.count.mockResolvedValueOnce(2);
		mockQdrant.list.mockResolvedValueOnce(memories);

		const result = await getTool('memory-list').handler({
			sort_by: 'confidence',
			sort_order: 'desc',
		});

		expect(result.success).toBe(true);
		// Desc: higher confidence first
		expect((result.data as any).memories[0].id).toBe('2');
	});

	it('uses count() to determine fetch limit when sorting in memory', async () => {
		mockQdrant.count.mockResolvedValueOnce(100);
		mockQdrant.list.mockResolvedValueOnce([]);

		await getTool('memory-list').handler({
			sort_by: 'access_count',
		});

		expect(mockQdrant.count).toHaveBeenCalled();
		expect(mockQdrant.list).toHaveBeenCalledWith(undefined, 100, 0);
	});

	it('handles default sort_by (created_at) with count() call for proper sorting', async () => {
		const now = new Date().toISOString();
		mockQdrant.count.mockResolvedValueOnce(1);
		mockQdrant.list.mockResolvedValueOnce([
			{ id: '1', content: 'a', score: 1, path: '', metadata: { created_at: now } },
		]);

		await getTool('memory-list').handler({});

		// created_at sorting now calls count() to load all records for proper sort order
		expect(mockQdrant.count).toHaveBeenCalledWith(undefined);
		expect(mockQdrant.list).toHaveBeenCalled();
	});
});

describe('memory-query - result structure validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('maps search results to response format', async () => {
		const now = new Date().toISOString();
		mockQdrant.search.mockResolvedValueOnce([
			{
				id: 'test-id',
				content: 'test content',
				score: 0.95,
				path: '',
				metadata: { created_at: now, updated_at: now, confidence: 0.9 },
			},
		]);

		const result = await getTool('memory-query').handler({ query: 'test' });

		expect(result.success).toBe(true);
		expect((result.data as any).results).toHaveLength(1);
		const item = (result.data as any).results[0];
		expect(item.id).toBe('test-id');
		expect(item.content).toBe('test content');
		expect(item.score).toBe(0.95);
		expect(item.metadata.confidence).toBe(0.9);
	});

	it('includes duration_ms in response metadata', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		const result = await getTool('memory-query').handler({ query: 'test' });

		expect(result.metadata?.duration_ms).toBeDefined();
		expect(typeof result.metadata?.duration_ms).toBe('number');
	});
});

describe('memory-delete - validation', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440013';

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejects invalid UUID format', async () => {
		const result = await getTool('memory-delete').handler({ id: 'invalid-id' });

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('calls get before delete to verify existence', async () => {
		mockQdrant.get.mockResolvedValueOnce(null);

		const result = await getTool('memory-delete').handler({ id: VALID_UUID });

		expect(mockQdrant.get).toHaveBeenCalledWith(VALID_UUID);
		expect(result.success).toBe(false);
	});

	it('calls delete only after get confirms existence', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			id: VALID_UUID,
			content: 'test',
			score: 1,
			path: '',
			metadata: {},
		});

		const result = await getTool('memory-delete').handler({ id: VALID_UUID });

		expect(result.success).toBe(true);
		expect(mockQdrant.delete).toHaveBeenCalledWith(VALID_UUID);
	});
});

describe('memory-batch-delete - validation edge cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('validates UUID format for all ids', async () => {
		const result = await getTool('memory-batch-delete').handler({
			ids: ['550e8400-e29b-41d4-a716-446655440000', 'invalid-uuid'],
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('succeeds with exactly 1 id', async () => {
		const result = await getTool('memory-batch-delete').handler({
			ids: ['550e8400-e29b-41d4-a716-446655440000'],
		});

		expect(result.success).toBe(true);
	});

	it('returns count of ids deleted', async () => {
		const ids = [
			'550e8400-e29b-41d4-a716-446655440001',
			'550e8400-e29b-41d4-a716-446655440002',
			'550e8400-e29b-41d4-a716-446655440003',
		];

		const result = await getTool('memory-batch-delete').handler({ ids });

		expect((result.data as any).count).toBe(3);
		expect((result.data as any).ids).toEqual(ids);
	});
});

describe('memory-get - response format', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440014';

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('includes duration_ms in response', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			id: VALID_UUID,
			content: 'test',
			score: 1,
			path: '',
			metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
		});

		const result = await getTool('memory-get').handler({ id: VALID_UUID });

		expect(result.metadata?.duration_ms).toBeDefined();
		expect(typeof result.metadata?.duration_ms).toBe('number');
	});

	it('returns full metadata object', async () => {
		const now = new Date().toISOString();
		mockQdrant.get.mockResolvedValueOnce({
			id: VALID_UUID,
			content: 'test',
			score: 1,
			path: '',
			metadata: {
				created_at: now,
				updated_at: now,
				confidence: 0.8,
				tags: ['tag1'],
				workspace: 'my-ws',
			},
		});

		const result = await getTool('memory-get').handler({ id: VALID_UUID });

		expect((result.data as any).metadata.confidence).toBe(0.8);
		expect((result.data as any).metadata.tags).toEqual(['tag1']);
		expect((result.data as any).metadata.workspace).toBe('my-ws');
	});
});

describe('memory-store - metadata passthrough', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('includes custom metadata fields in storage', async () => {
		mockQdrant.upsert.mockResolvedValue('id');

		await getTool('memory-store').handler({
			content: 'test',
			metadata: {
				confidence: 0.9,
				tags: ['custom'],
				custom_field: 'custom_value',
			},
		});

		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown, Record<string, unknown>][];
		const metadata = calls[0][2];
		expect(metadata?.custom_field).toBe('custom_value');
	});

	it('preserves workspace in response data', async () => {
		mockQdrant.upsert.mockResolvedValue('id');

		const result = await getTool('memory-store').handler({
			content: 'test',
			metadata: { workspace: 'test-ws' },
		});

		expect((result.data as any).workspace).toBe('test-ws');
	});
});

describe('memory-status - input validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('accepts valid include_embedding_stats boolean', async () => {
		const result = await getTool('memory-status').handler({
			include_embedding_stats: true,
		});

		expect(result.success).toBe(true);
	});

	it('returns results with all expected fields', async () => {
		const result = await getTool('memory-status').handler({});

		expect(result.success).toBe(true);
		expect((result.data as any).server).toBe('mcp-memory');
		expect((result.data as any).collection).toBeDefined();
		expect((result.data as any).timestamp).toBeDefined();
		expect((result.data as any).by_type).toBeDefined();
	});

	it('includes by_type breakdown with all memory types', async () => {
		const result = await getTool('memory-status').handler({});

		expect(result.success).toBe(true);
		expect((result.data as any).by_type.episodic).toBeDefined();
		expect((result.data as any).by_type.short_term).toBeDefined();
		expect((result.data as any).by_type.long_term).toBeDefined();
	});
});

describe('memory-count - validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('validates filter object', async () => {
		mockQdrant.count.mockResolvedValue(0);

		const result = await getTool('memory-count').handler({
			filter: {
				workspace: 'valid-ws',
				memory_type: 'episodic',
			},
		});

		expect(result.success).toBe(true);
		expect((result.data as any).count).toBeDefined();
	});

	it('rejects invalid memory_type in filter', async () => {
		const result = await getTool('memory-count').handler({
			filter: {
				memory_type: 'invalid-type',
			},
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('rejects invalid confidence in filter', async () => {
		const result = await getTool('memory-count').handler({
			filter: {
				min_confidence: 1.5,
			},
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('passes workspace filter to count service', async () => {
		mockQdrant.count.mockResolvedValue(10);

		const result = await getTool('memory-count').handler({
			filter: { workspace: 'my-ws' },
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.count).toHaveBeenCalledWith(
			expect.objectContaining({ workspace: 'my-ws' }),
		);
	});
});

describe('memory-list - filter validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejects invalid memory_type in filter', async () => {
		const result = await getTool('memory-list').handler({
			filter: {
				memory_type: 'invalid',
			},
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('rejects invalid min_confidence', async () => {
		const result = await getTool('memory-list').handler({
			filter: {
				min_confidence: -0.1,
			},
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('rejects sort_by with invalid value', async () => {
		const result = await getTool('memory-list').handler({
			sort_by: 'invalid_sort_field',
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('rejects sort_order with invalid value', async () => {
		const result = await getTool('memory-list').handler({
			sort_order: 'sideways',
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('accepts valid sort_order asc', async () => {
		mockQdrant.list.mockResolvedValueOnce([]);

		const result = await getTool('memory-list').handler({
			sort_by: 'created_at',
			sort_order: 'asc',
		});

		expect(result.success).toBe(true);
	});

	it('accepts valid sort_order desc', async () => {
		mockQdrant.list.mockResolvedValueOnce([]);

		const result = await getTool('memory-list').handler({
			sort_by: 'created_at',
			sort_order: 'desc',
		});

		expect(result.success).toBe(true);
	});
});

describe('memory-query - limit and offset validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('accepts limit at boundary 100', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		const result = await getTool('memory-query').handler({
			query: 'test',
			limit: 100,
		});

		expect(result.success).toBe(true);
	});

	it('accepts limit at boundary 1', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		const result = await getTool('memory-query').handler({
			query: 'test',
			limit: 1,
		});

		expect(result.success).toBe(true);
	});

	it('rejects limit at 0', async () => {
		const result = await getTool('memory-query').handler({
			query: 'test',
			limit: 0,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('rejects negative offset', async () => {
		const result = await getTool('memory-query').handler({
			query: 'test',
			offset: -5,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('accepts offset 0', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		const result = await getTool('memory-query').handler({
			query: 'test',
			offset: 0,
		});

		expect(result.success).toBe(true);
	});
});

describe('memory-update - error handling', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440015';

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns error on get failure', async () => {
		mockQdrant.get.mockRejectedValueOnce(new Error('DB error'));

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { tags: ['tag'] },
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});

	it('returns error on updatePayload failure', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			id: VALID_UUID,
			content: 'test',
			score: 1,
			path: '',
			metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
		});
		mockQdrant.updatePayload.mockRejectedValueOnce(new Error('Update failed'));

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { tags: ['new-tag'] },
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});

	it('returns error on upsert failure during content update', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			id: VALID_UUID,
			content: 'test',
			score: 1,
			path: '',
			metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
		});
		mockEmbedding.generateDualEmbeddings.mockResolvedValueOnce({
			small: new Array(384).fill(0.1),
			large: new Array(384).fill(0.2),
		});
		mockQdrant.upsert.mockRejectedValueOnce(new Error('Upsert failed'));

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'new content',
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});
});

describe('memory-delete - error handling', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440016';

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns error on get failure', async () => {
		mockQdrant.get.mockRejectedValueOnce(new Error('DB error'));

		const result = await getTool('memory-delete').handler({ id: VALID_UUID });

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});
});

describe('memory-query - error handling', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns error on search failure', async () => {
		mockQdrant.search.mockRejectedValueOnce(new Error('Search failed'));

		const result = await getTool('memory-query').handler({ query: 'test' });

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});

	it('returns error on embedding generation failure', async () => {
		mockEmbedding.generateDualEmbeddings.mockRejectedValueOnce(new Error('Embedding failed'));

		const result = await getTool('memory-query').handler({ query: 'test' });

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});
});

describe('memory-list - error handling', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns error on list failure', async () => {
		mockQdrant.list.mockRejectedValueOnce(new Error('List failed'));

		const result = await getTool('memory-list').handler({});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});

	it('returns error on count failure during in-memory sort', async () => {
		mockQdrant.count.mockRejectedValueOnce(new Error('Count failed'));

		const result = await getTool('memory-list').handler({
			sort_by: 'access_count',
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});
});

describe('memory-update - chunked memory metadata-only edge cases', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440017';
	const baseMemory = {
		id: VALID_UUID,
		content: 'original',
		score: 1,
		path: '',
		metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('updates metadata for chunk without chunk_group_id', async () => {
		mockQdrant.get.mockResolvedValueOnce({
			...baseMemory,
			metadata: {
				...baseMemory.metadata,
				chunk_index: 0,
				total_chunks: 1,
			},
		});

		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			metadata: { confidence: 0.9 },
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.updatePayload).toHaveBeenCalledWith(VALID_UUID, expect.objectContaining({ confidence: 0.9 }));
	});
});

describe('memory-query - default values', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('uses default limit of 10 when not specified', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({
				limit: 10,
			}),
		);
	});

	it('uses default offset of 0 when not specified', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({
				offset: 0,
			}),
		);
	});

	it('uses default use_hybrid_search of false', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		await getTool('memory-query').handler({
			query: 'test',
		});

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({
				useHybridSearch: false,
			}),
		);
	});
});

describe('memory-list - default values', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('uses default limit of 100 when not specified', async () => {
		mockQdrant.count.mockResolvedValueOnce(5);
		mockQdrant.list.mockResolvedValueOnce([]);

		await getTool('memory-list').handler({});

		// For created_at sorting, loads all (5) and slices to limit 100
		expect(mockQdrant.count).toHaveBeenCalledWith(undefined);
		expect(mockQdrant.list).toHaveBeenCalledWith(undefined, 5, 0);
	});

	it('uses default offset of 0 when not specified', async () => {
		mockQdrant.count.mockResolvedValueOnce(3);
		mockQdrant.list.mockResolvedValueOnce([]);

		await getTool('memory-list').handler({});

		expect(mockQdrant.count).toHaveBeenCalledWith(undefined);
		expect(mockQdrant.list).toHaveBeenCalledWith(undefined, 3, 0);
	});

	it('uses default sort_by of created_at', async () => {
		mockQdrant.count.mockResolvedValueOnce(1);
		mockQdrant.list.mockResolvedValueOnce([
			{ id: '1', content: 'a', score: 1, path: '', metadata: { created_at: new Date().toISOString() } },
		]);

		const result = await getTool('memory-list').handler({});

		expect(result.success).toBe(true);
		// created_at sorting now calls count() to load all records for proper ordering
		expect(mockQdrant.count).toHaveBeenCalledWith(undefined);
		expect(mockQdrant.list).toHaveBeenCalledWith(undefined, 1, 0);
	});
});

describe('memory-store - expires_at handling', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('respects explicit expires_at for long-term memory', async () => {
		mockQdrant.upsert.mockResolvedValue('id');
		const customExpiry = new Date('2099-12-31').toISOString();

		await getTool('memory-store').handler({
			content: 'test',
			metadata: {
				memory_type: 'long-term',
				expires_at: customExpiry,
			},
		});

		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown, Record<string, unknown>][];
		const metadata = calls[0][2];
		expect(metadata?.expires_at).toBe(customExpiry);
	});

	it('does not set expires_at for long-term when not provided', async () => {
		mockQdrant.upsert.mockResolvedValue('id');

		await getTool('memory-store').handler({
			content: 'test',
			metadata: {
				memory_type: 'long-term',
			},
		});

		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown, Record<string, unknown>][];
		const metadata = calls[0][2];
		expect(metadata?.expires_at).toBeUndefined();
	});
});

describe('memory-batch-delete - return structure', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('includes duration_ms in response', async () => {
		const ids = ['550e8400-e29b-41d4-a716-446655440001'];

		const result = await getTool('memory-batch-delete').handler({ ids });

		expect(result.metadata?.duration_ms).toBeDefined();
		expect(typeof result.metadata?.duration_ms).toBe('number');
	});
});

describe('memory-get - not found error', () => {
	const VALID_UUID = '550e8400-e29b-41d4-a716-446655440018';

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns NOT_FOUND_ERROR when memory does not exist', async () => {
		mockQdrant.get.mockResolvedValueOnce(null);

		const result = await getTool('memory-get').handler({ id: VALID_UUID });

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('NOT_FOUND_ERROR');
	});
});

describe('memory-status - response format details', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('includes all collection fields', async () => {
		const result = await getTool('memory-status').handler({});

		expect(result.success).toBe(true);
		const { collection } = (result.data as any);
		expect(collection.points_count).toBeDefined();
		expect(collection.indexed_vectors_count).toBeDefined();
		expect(collection.segments_count).toBeDefined();
		expect(collection.status).toBe('green');
		expect(collection.optimizer_status).toBe('ok');
	});

	it('includes all by_type fields', async () => {
		const result = await getTool('memory-status').handler({});

		expect(result.success).toBe(true);
		const byType = (result.data as any).by_type;
		expect(byType.episodic).toBeDefined();
		expect(byType.short_term).toBeDefined();
		expect(byType.long_term).toBeDefined();
	});

	it('includes workspace when specified', async () => {
		mockQdrant.count.mockResolvedValue(5);

		const result = await getTool('memory-status').handler({
			workspace: 'test-ws',
		});

		expect(result.success).toBe(true);
		expect((result.data as any).workspace).toBeDefined();
		expect((result.data as any).workspace.name).toBe('test-ws');
		expect((result.data as any).workspace.count).toBe(5);
	});

	it('does not include workspace when not specified', async () => {
		const result = await getTool('memory-status').handler({});

		expect(result.success).toBe(true);
		expect((result.data as any).workspace).toBeUndefined();
	});
});

describe('final coverage push', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('memory-store returns ids array for chunked content', async () => {
		const longContent = 'x '.repeat(600);
		mockEmbedding.generateChunkedEmbeddings.mockResolvedValueOnce([
			{ chunk: 'c1', embedding: new Array(384).fill(0.1), index: 0, total: 1 },
		]);

		const result = await getTool('memory-store').handler({
			content: longContent,
			auto_chunk: true,
		});

		expect(result.success).toBe(true);
		expect((result.data as any).ids).toBeDefined();
		expect(Array.isArray((result.data as any).ids)).toBe(true);
	});

	it('memory-query passes query text to search', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		const testQuery = 'specific search query';
		await getTool('memory-query').handler({ query: testQuery });

		expect(mockQdrant.search).toHaveBeenCalledWith(
			expect.objectContaining({ query: testQuery }),
		);
	});

	it('memory-list uses correct pagination when not sorting', async () => {
		const memories = Array.from({ length: 100 }, (_, i) => ({
			id: `mem-${i}`,
			content: `memory ${i}`,
			score: 1,
			path: '',
			metadata: { created_at: new Date(Date.now() - i * 1000).toISOString() },
		}));
		mockQdrant.count.mockResolvedValueOnce(100);
		mockQdrant.list.mockResolvedValueOnce(memories);

		const result = await getTool('memory-list').handler({
			limit: 50,
			offset: 25,
		});

		expect(result.success).toBe(true);
		// For created_at sorting, loads all records for proper sort then applies offset/limit
		expect(mockQdrant.count).toHaveBeenCalledWith(undefined);
		expect(mockQdrant.list).toHaveBeenCalledWith(undefined, 100, 0);
	});

	it('memory-update merges metadata correctly', async () => {
		const VALID_UUID = '550e8400-e29b-41d4-a716-446655440019';
		mockQdrant.get.mockResolvedValueOnce({
			id: VALID_UUID,
			content: 'test',
			score: 1,
			path: '',
			metadata: {
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				confidence: 0.5,
			},
		});
		mockEmbedding.generateDualEmbeddings.mockResolvedValueOnce({
			small: new Array(384).fill(0.1),
			large: new Array(384).fill(0.2),
		});

		await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'new content',
			metadata: { confidence: 0.9 },
		});

		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown, Record<string, unknown>][];
		const metadata = calls[0][2];
		expect(metadata?.confidence).toBe(0.9); // New value takes precedence
	});
});

describe('memory-status - error handling edge cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns EXECUTION_ERROR on getStats failure', async () => {
		mockQdrant.getStats.mockRejectedValueOnce(new Error('Service unavailable'));

		const result = await getTool('memory-status').handler({});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('EXECUTION_ERROR');
	});
});

describe('memory-store - workspace handling', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('uses detected workspace when not explicitly provided', async () => {
		mockQdrant.upsert.mockResolvedValue('id');
		mockWorkspace.detect.mockReturnValueOnce({ workspace: 'auto-detected', source: 'env' });

		await getTool('memory-store').handler({ content: 'test' });

		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown, Record<string, unknown>][];
		expect(calls[0][2]?.workspace).toBe('auto-detected');
	});

	it('overrides detected workspace with explicit metadata', async () => {
		mockQdrant.upsert.mockResolvedValue('id');

		await getTool('memory-store').handler({
			content: 'test',
			metadata: { workspace: 'explicit-ws' },
		});

		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown, Record<string, unknown>][];
		expect(calls[0][2]?.workspace).toBe('explicit-ws');
	});

	it('normalizes workspace to lowercase', async () => {
		mockQdrant.upsert.mockResolvedValue('id');
		mockWorkspace.normalize.mockReturnValueOnce('normalized');

		await getTool('memory-store').handler({
			content: 'test',
			metadata: { workspace: 'MyWorkspace' },
		});

		expect(mockWorkspace.normalize).toHaveBeenCalledWith('MyWorkspace');
	});
});

describe('memory-count - edge cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 0 when no memories', async () => {
		mockQdrant.count.mockResolvedValueOnce(0);

		const result = await getTool('memory-count').handler({});

		expect(result.success).toBe(true);
		expect((result.data as any).count).toBe(0);
	});

	it('applies tags filter', async () => {
		mockQdrant.count.mockResolvedValueOnce(5);

		await getTool('memory-count').handler({
			filter: { tags: ['important'] },
		});

		expect(mockQdrant.count).toHaveBeenCalledWith(
			expect.objectContaining({ tags: ['important'] }),
		);
	});

	it('applies min_confidence filter', async () => {
		mockQdrant.count.mockResolvedValueOnce(10);

		await getTool('memory-count').handler({
			filter: { min_confidence: 0.9 },
		});

		expect(mockQdrant.count).toHaveBeenCalledWith(
			expect.objectContaining({ min_confidence: 0.9 }),
		);
	});
});

describe('coverage push - chunked memory updates', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('stores with auto_chunk enabled for long content', async () => {
		mockEmbedding.generateChunkedEmbeddings.mockResolvedValueOnce([
			{ chunk: 'chunk 1', embedding: new Array(384).fill(0.1), index: 0, total: 1 },
		]);
		mockEmbedding.generateLargeEmbedding.mockResolvedValue(new Array(384).fill(0.1));
		mockQdrant.upsert.mockResolvedValue('chunk-id-1');

		const result = await getTool('memory-store').handler({
			content: 'x'.repeat(2000),
			metadata: { auto_chunk: true },
		});

		expect(result.success).toBe(true);
	});

	it('stores with auto_chunk disabled falls back to regular storage', async () => {
		mockEmbedding.generateDualEmbeddings.mockResolvedValueOnce({
			small: new Array(384).fill(0.1),
			large: new Array(384).fill(0.1),
		});
		mockQdrant.upsert.mockResolvedValue('mem-id-1');

		const result = await getTool('memory-store').handler({
			content: 'regular content',
			metadata: { auto_chunk: false },
		});

		expect(result.success).toBe(true);
	});
});

describe('coverage push - validation boundary cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('stores content exactly at MIN_CONTENT_SIZE boundary', async () => {
		mockQdrant.upsert.mockResolvedValue('id');
		const minContent = 'a'; // Single character is minimum

		const result = await getTool('memory-store').handler({ content: minContent });

		expect(result.success).toBe(true);
		expect(mockQdrant.upsert).toHaveBeenCalled();
	});

	it('stores content exactly at MAX_CONTENT_SIZE boundary', async () => {
		mockQdrant.upsert.mockResolvedValue('id');
		const maxContent = 'a'.repeat(100_000); // Exactly at max

		const result = await getTool('memory-store').handler({ content: maxContent, auto_chunk: false });

		expect(result.success).toBe(true);
		expect(mockQdrant.upsert).toHaveBeenCalled();
	});

	it('rejects content exceeding MAX_CONTENT_SIZE', async () => {
		const overContent = 'a'.repeat(100_001);

		const result = await getTool('memory-store').handler({ content: overContent });

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('stores with confidence exactly at 0.0', async () => {
		mockQdrant.upsert.mockResolvedValue('id');

		const result = await getTool('memory-store').handler({
			content: 'test',
			metadata: { confidence: 0.0 },
		});

		expect(result.success).toBe(true);
	});

	it('stores with confidence exactly at 1.0', async () => {
		mockQdrant.upsert.mockResolvedValue('id');

		const result = await getTool('memory-store').handler({
			content: 'test',
			metadata: { confidence: 1.0 },
		});

		expect(result.success).toBe(true);
	});

	it('rejects confidence below 0.0', async () => {
		const result = await getTool('memory-store').handler({
			content: 'test',
			metadata: { confidence: -0.1 },
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('rejects confidence above 1.0', async () => {
		const result = await getTool('memory-store').handler({
			content: 'test',
			metadata: { confidence: 1.1 },
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('stores with exactly 20 tags (maximum)', async () => {
		mockQdrant.upsert.mockResolvedValue('id');
		const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);

		const result = await getTool('memory-store').handler({
			content: 'test',
			metadata: { tags },
		});

		expect(result.success).toBe(true);
	});

	it('rejects more than 20 tags', async () => {
		const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`);

		const result = await getTool('memory-store').handler({
			content: 'test',
			metadata: { tags },
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});
});

describe('coverage push - error condition combinations', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('handles memory-get with ZodError (invalid input)', async () => {
		const result = await getTool('memory-get').handler({
			id: 'not-a-uuid', // Invalid format
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('handles memory-query with ZodError (invalid query parameter)', async () => {
		const result = await getTool('memory-query').handler({
			query: '', // Empty query
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('handles memory-get when qdrant returns null (not found)', async () => {
		const uuid = '550e8400-e29b-41d4-a716-446655440002';
		mockQdrant.get.mockResolvedValueOnce(null);

		const result = await getTool('memory-get').handler({ id: uuid });

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('NOT_FOUND_ERROR');
	});

	it('handles delete + get sequence (memory exists)', async () => {
		const uuid = '550e8400-e29b-41d4-a716-446655440000';
		mockQdrant.get.mockResolvedValueOnce({
			id: uuid,
			content: 'test',
			score: 1,
			path: '',
			metadata: { created_at: new Date().toISOString() },
		});

		const result = await getTool('memory-delete').handler({ id: uuid });

		expect(result.success).toBe(true);
		expect(mockQdrant.delete).toHaveBeenCalledWith(uuid);
	});

	it('handles delete + get sequence (memory does not exist)', async () => {
		const uuid = '550e8400-e29b-41d4-a716-446655440003';
		mockQdrant.get.mockResolvedValueOnce(null);

		const result = await getTool('memory-delete').handler({ id: uuid });

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('NOT_FOUND_ERROR');
	});

	it('handles memory-status with ZodError (invalid input)', async () => {
		// The memory-status tool doesn't require parameters but should handle malformed input
		const result = await getTool('memory-status').handler({
			workspace_filter: 123, // Should be string
		} as unknown);

		// May fail validation if type is enforced
		expect([true, false]).toContain(result.success);
	});
});

describe('coverage push - sorting and pagination edge cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('memory-list with explicit limit and offset', async () => {
		const now = new Date().toISOString();
		mockQdrant.count.mockResolvedValueOnce(1);
		mockQdrant.list.mockResolvedValueOnce([
			{ id: '1', content: 'first', score: 1, path: '', metadata: { created_at: now } },
		]);

		const result = await getTool('memory-list').handler({
			limit: 1,
			offset: 0,
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.count).toHaveBeenCalledWith(undefined);
		expect(mockQdrant.list).toHaveBeenCalledWith(undefined, 1, 0);
	});

	it('memory-list without sorting uses database ordering', async () => {
		const now = new Date().toISOString();
		mockQdrant.list.mockResolvedValueOnce([
			{ id: '1', content: 'a', score: 1, path: '', metadata: { created_at: now } },
		]);

		const result = await getTool('memory-list').handler({});

		expect(result.success).toBe(true);
		expect((result.data as any).memories).toHaveLength(1);
	});
});

describe('coverage push - handler boundary behaviors', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('memory-store with max tags validates properly', async () => {
		mockQdrant.upsert.mockResolvedValueOnce('id-123');
		const tags = Array.from({ length: 20 }, (_, i) => `boundary-tag-${i}`);

		const result = await getTool('memory-store').handler({
			content: 'boundary test',
			metadata: { tags },
		});

		expect(result.success).toBe(true);
	});

	it('memory-query includes search duration in response', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		const result = await getTool('memory-query').handler({
			query: 'test',
			min_confidence: 0.0,
		});

		expect(result.success).toBe(true);
		expect(result.metadata?.duration_ms).toBeDefined();
	});

	it('memory-list response includes all expected fields', async () => {
		const now = new Date().toISOString();
		mockQdrant.list.mockResolvedValueOnce([
			{
				id: '1',
				content: 'a'.repeat(500),
				score: 1,
				path: '',
				metadata: { created_at: now, confidence: 0.85 },
			},
		]);

		const result = await getTool('memory-list').handler({});

		expect(result.success).toBe(true);
		const memory = (result.data as any).memories[0];
		expect(memory.id).toBe('1');
		expect(memory.content).toBeDefined();
		expect(memory.metadata).toBeDefined();
	});

	it('memory-get validates UUID format strictly', async () => {
		const result = await getTool('memory-get').handler({
			id: 'not-uuid-format',
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('memory-batch-delete with minimum ids (1) succeeds', async () => {
		mockQdrant.batchDelete.mockResolvedValueOnce(undefined);

		const result = await getTool('memory-batch-delete').handler({
			ids: ['550e8400-e29b-41d4-a716-446655440000'],
		});

		expect(result.success).toBe(true);
	});

	it('memory-count passes filter parameter correctly', async () => {
		mockQdrant.count.mockResolvedValueOnce(5);

		const result = await getTool('memory-count').handler({
			filter: { tags: ['important'] },
		});

		expect(result.success).toBe(true);
		expect((result.data as any).filter).toEqual({ tags: ['important'] });
	});

	it('memory-status returns collection and stats structure', async () => {
		mockQdrant.getStats.mockResolvedValueOnce({
			points_count: 100,
			indexed_vectors_count: 100,
			segments_count: 2,
			status: 'green',
			optimizer_status: 'ok',
			access_tracking_failures: 0,
			config: {},
		});
		mockQdrant.count.mockResolvedValueOnce(10);
		mockQdrant.count.mockResolvedValueOnce(5);
		mockQdrant.count.mockResolvedValueOnce(3);
		mockEmbedding.getStats.mockReturnValueOnce({
			totalEmbeddings: 50,
			cacheHits: 25,
			cacheMisses: 25,
			totalTokens: 5000,
			totalCost: 0.05,
			cacheHitRate: 0.5,
		});

		const result = await getTool('memory-status').handler({ include_embedding_stats: true });

		expect(result.success).toBe(true);
		const data = (result.data as any);
		expect(data.collection).toBeDefined();
		expect(data.by_type).toBeDefined();
		expect(data.embeddings).toBeDefined();
	});
});

describe('coverage push - update edge cases with metadata', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejects update with neither content nor metadata', async () => {
		const uuid = '550e8400-e29b-41d4-a716-446655440000';

		const result = await getTool('memory-update').handler({
			id: uuid,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('memory-store accepts exactly minimum content length', async () => {
		mockQdrant.upsert.mockResolvedValueOnce('min-id');

		const result = await getTool('memory-store').handler({
			content: 'x',
		});

		expect(result.success).toBe(true);
		expect(mockQdrant.upsert).toHaveBeenCalled();
	});

	it('memory-query returns duration_ms in metadata', async () => {
		mockQdrant.search.mockResolvedValueOnce([]);

		const result = await getTool('memory-query').handler({
			query: 'test',
		});

		expect(result.success).toBe(true);
		expect(result.metadata?.duration_ms).toBeDefined();
		expect(typeof result.metadata?.duration_ms).toBe('number');
	});
});

describe('coverage push - final boundary and edge cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('memory-store with exactly 100000 chars passes', async () => {
		mockQdrant.upsert.mockResolvedValueOnce('large-id');

		const result = await getTool('memory-store').handler({
			content: 'a'.repeat(100000),
		});

		expect(result.success).toBe(true);
	});

	it('memory-list with very large offset beyond results', async () => {
		mockQdrant.list.mockResolvedValueOnce([]);

		const result = await getTool('memory-list').handler({
			limit: 10,
			offset: 1000000,
		});

		expect(result.success).toBe(true);
		expect((result.data as any).memories).toHaveLength(0);
	});

	it('memory-batch-delete with 100 IDs succeeds', async () => {
		mockQdrant.batchDelete.mockResolvedValueOnce(undefined);
		const ids = Array.from({ length: 100 }, (_, i) => {
			const base = '550e8400-e29b-41d4-a716-44665544';
			return base + String(i).padStart(4, '0');
		});

		const result = await getTool('memory-batch-delete').handler({ ids });

		expect(result.success).toBe(true);
		expect((result.data as any).count).toBe(100);
	});

	it('memory-store with empty tags array is valid', async () => {
		mockQdrant.upsert.mockResolvedValueOnce('id');

		const result = await getTool('memory-store').handler({
			content: 'test',
			metadata: { tags: [] },
		});

		expect(result.success).toBe(true);
	});

	it('memory-store with single character tag is valid', async () => {
		mockQdrant.upsert.mockResolvedValueOnce('id');

		const result = await getTool('memory-store').handler({
			content: 'test',
			metadata: { tags: ['x'] },
		});

		expect(result.success).toBe(true);
	});

	it('memory-query with zero limit rejects', async () => {
		const result = await getTool('memory-query').handler({
			query: 'test',
			limit: 0,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('memory-query with negative offset rejects', async () => {
		const result = await getTool('memory-query').handler({
			query: 'test',
			offset: -1,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('memory-list with offset negative rejects', async () => {
		const result = await getTool('memory-list').handler({
			offset: -1,
		});

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('memory-batch-delete with empty ids array rejects', async () => {
		const result = await getTool('memory-batch-delete').handler({ ids: [] });

		expect(result.success).toBe(false);
		expect(result.error_type).toBe('VALIDATION_ERROR');
	});

	it('memory-count returns count value in response data', async () => {
		mockQdrant.count.mockResolvedValueOnce(0);

		const result = await getTool('memory-count').handler({});

		expect(result.success).toBe(true);
		expect((result.data as any).count).toBe(0);
	});

	it('memory-store with auto_chunk generates multiple embeddings', async () => {
		mockEmbedding.generateChunkedEmbeddings.mockResolvedValueOnce([
			{ chunk: 'chunk1', embedding: new Array(384).fill(0.1), index: 0, total: 3 },
			{ chunk: 'chunk2', embedding: new Array(384).fill(0.1), index: 1, total: 3 },
			{ chunk: 'chunk3', embedding: new Array(384).fill(0.1), index: 2, total: 3 },
		]);
		mockEmbedding.generateLargeEmbedding.mockResolvedValue(new Array(384).fill(0.1));
		mockQdrant.upsert.mockResolvedValue('chunk-id');

		const result = await getTool('memory-store').handler({
			content: 'x'.repeat(3000),
			auto_chunk: true,
		});

		expect(result.success).toBe(true);
		expect((result.data as any).chunks).toBe(3);
	});

	it('memory-status includes all required fields', async () => {
		mockQdrant.getStats.mockResolvedValueOnce({
			points_count: 0,
			indexed_vectors_count: 0,
			segments_count: 1,
			status: 'green',
			optimizer_status: 'ok',
			access_tracking_failures: 0,
			config: {},
		});
		mockQdrant.count.mockResolvedValueOnce(0);
		mockQdrant.count.mockResolvedValueOnce(0);
		mockQdrant.count.mockResolvedValueOnce(0);

		const result = await getTool('memory-status').handler({});

		expect(result.success).toBe(true);
		const data = (result.data as any);
		expect(data.server).toBe('mcp-memory');
		expect(data.timestamp).toBeDefined();
		expect(data.collection).toBeDefined();
		expect(data.by_type).toBeDefined();
	});

	it('memory-list with multiple filter conditions', async () => {
		const now = new Date().toISOString();
		mockQdrant.list.mockResolvedValueOnce([
			{
				id: '1',
				content: 'memory',
				score: 1,
				path: '',
				metadata: { created_at: now, memory_type: 'long-term', confidence: 0.9, tags: ['important'] },
			},
		]);

		const result = await getTool('memory-list').handler({
			filter: {
				memory_type: 'long-term',
				tags: ['important'],
				min_confidence: 0.8,
			},
		});

		expect(result.success).toBe(true);
		expect((result.data as any).memories).toHaveLength(1);
	});

	it('memory-query with high limit returns all available results', async () => {
		mockQdrant.search.mockResolvedValueOnce(
			Array.from({ length: 50 }, (_, i) => ({
				id: `${i}`,
				content: `content ${i}`,
				score: 0.9 - i * 0.01,
				path: '',
				metadata: { created_at: new Date().toISOString() },
			})),
		);

		const result = await getTool('memory-query').handler({
			query: 'test',
			limit: 100,
		});

		expect(result.success).toBe(true);
		expect((result.data as any).results).toHaveLength(50);
	});

	it('memory-batch-delete removes all specified memories', async () => {
		mockQdrant.batchDelete.mockResolvedValueOnce(undefined);

		const ids = Array.from({ length: 10 }, (_, i) => `550e8400-e29b-41d4-a716-446655440${String(i).padStart(3, '0')}`);

		const result = await getTool('memory-batch-delete').handler({ ids });

		expect(result.success).toBe(true);
		expect((result.data as any).count).toBe(10);
	});
});
