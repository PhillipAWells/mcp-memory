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
		// Each upsert call passes (id, embeddings, payload) — extract the payload (3rd arg)
		const calls = mockQdrant.upsert.mock.calls as unknown as [string, unknown, Record<string, unknown>][];
		const groupId0 = calls[0]?.[2]?.chunk_group_id;
		const groupId1 = calls[1]?.[2]?.chunk_group_id;
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
		await getTool('memory-list').handler({ limit: 5, offset: 10 });
		expect(mockQdrant.list).toHaveBeenCalledWith(undefined, 5, 10);
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
		// count() is called twice: once for warn-check, once for fetchLimit
		mockQdrant.count.mockResolvedValueOnce(5).mockResolvedValueOnce(5);
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
		// count() is called twice: once for warn-check, once for fetchLimit
		mockQdrant.count.mockResolvedValueOnce(20000).mockResolvedValueOnce(20000);
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

	it('reindexes when content is updated and reindex=true', async () => {
		mockQdrant.get.mockResolvedValueOnce(baseMemory);
		const result = await getTool('memory-update').handler({
			id: VALID_UUID,
			content: 'new content here',
			reindex: true,
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
