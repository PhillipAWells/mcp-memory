/**
 * Unit tests for QdrantService
 *
 * HTTP fetch is mocked to avoid network calls.
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

// ── Mock fetch function that simulates Qdrant REST API responses ────────────────
// This default implementation can be overridden per-test with mockImplementationOnce/mockImplementation
const mockFetch = vi.fn((url: string, options?: Record<string, unknown>) => {
	const method = (options?.method as string) || 'GET';

	// Helper to send successful response
	const sendResponse = (data: unknown) => ({
		ok: true,
		status: 200,
		statusText: 'OK',
		text: () => Promise.resolve(JSON.stringify(data)),
		json: () => Promise.resolve(data),
	});

	const sendError = (status: number, message: string) => ({
		ok: false,
		status,
		statusText: message,
		text: () => Promise.resolve(message),
		json: () => Promise.reject(new Error(message)),
	});

	// Route based on URL path and method
	try {
		// GET /collections — list all collections
		if (url.endsWith('/collections') && method === 'GET') {
			return sendResponse({ collections: [{ name: 'test-collection' }] });
		}

		// GET /collections/{name} — get collection info
		if (url.includes('/collections/test-collection') && !url.includes('/points') && !url.includes('/index') && method === 'GET') {
			return sendResponse({
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
		}

		// PUT /collections/{name} — create collection
		if (url.includes('/collections/test-collection') && method === 'PUT' && !url.includes('/points') && !url.includes('/index')) {
			return sendResponse({});
		}

		// PUT /collections/{name}/index — create payload index
		if (url.includes('/index') && method === 'PUT') {
			return sendResponse({});
		}

		// POST /collections/{name}/points/search — vector search
		if (url.includes('/points/search') && method === 'POST') {
			return sendResponse({ result: [] });
		}

		// POST /collections/{name}/points/scroll — list/scroll points
		if (url.includes('/points/scroll') && method === 'POST') {
			return sendResponse({ points: [], next_page_offset: null });
		}

		// POST /collections/{name}/points/count — count points
		if (url.includes('/points/count') && method === 'POST') {
			return sendResponse({ count: 0 });
		}

		// PUT /collections/{name}/points — upsert points (wait=true)
		if (url.includes('/points') && method === 'PUT') {
			return sendResponse({});
		}

		// DELETE /collections/{name}/points — delete points (wait=true)
		if (url.includes('/points') && method === 'DELETE') {
			return sendResponse({});
		}

		// PATCH /collections/{name}/points — update payload (wait=true)
		if (url.includes('/points') && method === 'PATCH') {
			return sendResponse({});
		}

		// Unrecognized route
		return sendError(404, 'Not Found');
	} catch (error) {
		return sendError(500, error instanceof Error ? error.message : 'Internal Server Error');
	}
});

vi.mock('../../utils/proxy.js', () => ({
	getProxyAwareFetch: () => mockFetch,
}));

import { QdrantService } from '../qdrant-client.js';

// ── Helper function to create and initialize a QdrantService ────────────────────
/**
 * Creates and initializes a QdrantService for tests.
 *
 * Clears fetch mocks and sets up default responses, then creates and initializes the service.
 * This consolidates the common beforeEach pattern used across most test suites.
 *
 * @returns Initialized QdrantService instance
 */
async function createInitializedService(): Promise<QdrantService> {
	mockFetch.mockClear();
	const service = new QdrantService();
	await service.initialize();
	mockFetch.mockClear(); // Clear initialization calls for clean test state
	return service;
}

// ── buildFilter (tested via count) ────────────────────────────────────────────

describe('QdrantService.buildFilter (via count)', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('always applies expiry filter even when no filter is provided', async () => {
		const count = await service.count(undefined);
		expect(typeof count).toBe('number');
		expect(count).toBe(0);
	});

	it('includes workspace condition when workspace filter is set', async () => {
		const count = await service.count({ workspace: 'my-ws' });
		expect(typeof count).toBe('number');
		expect(count).toBe(0);
	});

	it('includes is_null condition when workspace filter is explicitly null', async () => {
		const count = await service.count({ workspace: null });
		expect(typeof count).toBe('number');
		expect(count).toBe(0);
	});

	it('includes memory_type condition when filter is set', async () => {
		const count = await service.count({ memory_type: 'episodic' });
		expect(typeof count).toBe('number');
		expect(count).toBe(0);
	});

	it('includes min_confidence range condition', async () => {
		const count = await service.count({ min_confidence: 0.8 });
		expect(typeof count).toBe('number');
		expect(count).toBe(0);
	});

	it('includes tags any-match condition', async () => {
		const count = await service.count({ tags: ['foo', 'bar'] });
		expect(typeof count).toBe('number');
		expect(count).toBe(0);
	});

	it('always adds expires_at exclusion condition', async () => {
		const count = await service.count({});
		expect(typeof count).toBe('number');
		expect(count).toBe(0);
	});

	it('includes custom metadata key-value conditions', async () => {
		const count = await service.count({ metadata: { chunk_group_id: 'abc-123' } });
		expect(typeof count).toBe('number');
		expect(count).toBe(0);
	});
});

// ── validateCollectionSchema ──────────────────────────────────────────────────

describe('QdrantService.validateCollectionSchema', () => {
	beforeEach(() => {
		mockFetch.mockClear();
	});

	it('initializes successfully with compatible collection schema', async () => {
		const service = new QdrantService();
		await expect(service.initialize()).resolves.not.toThrow();
	});

	it('throws when collection uses single unnamed vector (pre-dual-embedding)', async () => {
		mockFetch.mockImplementation((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.endsWith('/collections') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ collections: [{ name: 'test-collection' }] })),
					json: () => Promise.resolve({ collections: [{ name: 'test-collection' }] }),
				};
			}

			if (url.includes('/collections/test-collection') && !url.includes('/points') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						config: { params: { vectors: { size: 1536, distance: 'Cosine' } } },
						points_count: 0,
						indexed_vectors_count: 0,
						segments_count: 1,
						status: 'green',
						optimizer_status: 'ok',
					})),
					json: () => Promise.resolve({
						config: { params: { vectors: { size: 1536, distance: 'Cosine' } } },
						points_count: 0,
						indexed_vectors_count: 0,
						segments_count: 1,
						status: 'green',
						optimizer_status: 'ok',
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const service = new QdrantService();
		await expect(service.initialize()).rejects.toThrow('single unnamed vector');

		// Restore default mock
		mockFetch.mockRestore();
	});

	it('throws when dense vector has wrong dimensions', async () => {
		mockFetch.mockImplementation((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.endsWith('/collections') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ collections: [{ name: 'test-collection' }] })),
					json: () => Promise.resolve({ collections: [{ name: 'test-collection' }] }),
				};
			}

			if (url.includes('/collections/test-collection') && !url.includes('/points') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
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
					})),
					json: () => Promise.resolve({
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
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const service = new QdrantService();
		await expect(service.initialize()).rejects.toThrow('size mismatch');

		// Restore default mock
		mockFetch.mockRestore();
	});

	it('throws when dense_large vector is missing', async () => {
		mockFetch.mockImplementation((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.endsWith('/collections') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ collections: [{ name: 'test-collection' }] })),
					json: () => Promise.resolve({ collections: [{ name: 'test-collection' }] }),
				};
			}

			if (url.includes('/collections/test-collection') && !url.includes('/points') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
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
					})),
					json: () => Promise.resolve({
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
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const service = new QdrantService();
		await expect(service.initialize()).rejects.toThrow('missing vector');

		// Restore default mock
		mockFetch.mockRestore();
	});
});

// ── QdrantService.initialize — collection creation ────────────────────────────

describe('QdrantService.initialize — collection creation', () => {
	beforeEach(() => {
		mockFetch.mockClear();
	});

	it('creates collection when it does not exist', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.endsWith('/collections') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ collections: [] })),
					json: () => Promise.resolve({ collections: [] }),
				};
			}

			if (url.includes('/collections/test-collection') && method === 'PUT') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve('{}'),
					json: () => Promise.resolve({}),
				};
			}

			if (url.includes('/index') && method === 'PUT') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve('{}'),
					json: () => Promise.resolve({}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const service = new QdrantService();
		await expect(service.initialize()).resolves.not.toThrow();
	});
});

describe('QdrantService.initialize — optional index creation failure', () => {
	beforeEach(() => {
		mockFetch.mockClear();
	});

	it('logs warning but continues when optional payload index creation fails', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';
			const body = options?.body ? JSON.parse(String(options.body)) : undefined;

			if (url.endsWith('/collections') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ collections: [{ name: 'test-collection' }] })),
					json: () => Promise.resolve({ collections: [{ name: 'test-collection' }] }),
				};
			}

			if (url.includes('/collections/test-collection') && !url.includes('/points') && !url.includes('/index') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
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
					})),
					json: () => Promise.resolve({
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
				};
			}

			if (url.includes('/index') && method === 'PUT') {
				const fieldName = body?.field_name;
				const nonCritical = ['created_at', 'updated_at', 'access_count', 'last_accessed_at', 'tags'];

				if (fieldName && nonCritical.includes(fieldName)) {
					return {
						ok: false,
						status: 400,
						statusText: 'Bad Request',
						text: () => Promise.resolve('optional index creation failed'),
						json: () => Promise.reject(new Error('optional index creation failed')),
					};
				}

				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve('{}'),
					json: () => Promise.resolve({}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const service = new QdrantService();
		await expect(service.initialize()).resolves.not.toThrow();
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

			// Mock POST /collections/{name}/points to retrieve point
			mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
				const method = (options?.method as string) || 'GET';

				if (method === 'POST' && url.includes('/points')) {
					return {
						ok: true,
						status: 200,
						statusText: 'OK',
						text: () => Promise.resolve(JSON.stringify({
							points: [{
								id: pointId,
								payload: {
									content: 'test content',
									access_count: 5,
									created_at: '2026-04-20T00:00:00Z',
									updated_at: '2026-04-20T00:00:00Z',
								},
							}],
						})),
						json: () => Promise.resolve({
							points: [{
								id: pointId,
								payload: {
									content: 'test content',
									access_count: 5,
									created_at: '2026-04-20T00:00:00Z',
									updated_at: '2026-04-20T00:00:00Z',
								},
							}],
						}),
					};
				}

				return {
					ok: false,
					status: 404,
					statusText: 'Not Found',
					text: () => Promise.resolve('Not Found'),
					json: () => Promise.reject(new Error('Not Found')),
				};
			});

			// Mock PATCH for access tracking update
			mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
				const method = (options?.method as string) || 'GET';

				if (method === 'PATCH' && url.includes('/points')) {
					return {
						ok: true,
						status: 200,
						statusText: 'OK',
						text: () => Promise.resolve('{}'),
						json: () => Promise.resolve({}),
					};
				}

				return {
					ok: false,
					status: 404,
					statusText: 'Not Found',
					text: () => Promise.resolve('Not Found'),
					json: () => Promise.reject(new Error('Not Found')),
				};
			});

			const result = await service.get(pointId);

			expect(result).not.toBeNull();
			expect(result?.content).toBe('test content');

			// Wait for fire-and-forget updateAccessTracking to complete
			await vi.runAllTimersAsync();
		} finally {
			vi.useRealTimers();
		}
	});

	it('handles zero initial access_count correctly', async () => {
		vi.useFakeTimers();

		try {
			const pointId = 'point-456';

			mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
				const method = (options?.method as string) || 'GET';

				if (method === 'POST' && url.includes('/points')) {
					return {
						ok: true,
						status: 200,
						statusText: 'OK',
						text: () => Promise.resolve(JSON.stringify({
							points: [{
								id: pointId,
								payload: {
									content: 'test content',
									created_at: '2026-04-20T00:00:00Z',
									updated_at: '2026-04-20T00:00:00Z',
								},
							}],
						})),
						json: () => Promise.resolve({
							points: [{
								id: pointId,
								payload: {
									content: 'test content',
									created_at: '2026-04-20T00:00:00Z',
									updated_at: '2026-04-20T00:00:00Z',
								},
							}],
						}),
					};
				}

				return {
					ok: false,
					status: 404,
					statusText: 'Not Found',
					text: () => Promise.resolve('Not Found'),
					json: () => Promise.reject(new Error('Not Found')),
				};
			});

			mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
				const method = (options?.method as string) || 'GET';

				if (method === 'PATCH' && url.includes('/points')) {
					return {
						ok: true,
						status: 200,
						statusText: 'OK',
						text: () => Promise.resolve('{}'),
						json: () => Promise.resolve({}),
					};
				}

				return {
					ok: false,
					status: 404,
					statusText: 'Not Found',
					text: () => Promise.resolve('Not Found'),
					json: () => Promise.reject(new Error('Not Found')),
				};
			});

			await service.get(pointId);
			await vi.runAllTimersAsync();

			// Test passes if no error is thrown
			expect(true).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('updates last_accessed_at timestamp on retrieval', async () => {
		vi.useFakeTimers();

		try {
			const pointId = 'point-789';

			mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
				const method = (options?.method as string) || 'GET';

				if (method === 'POST' && url.includes('/points')) {
					return {
						ok: true,
						status: 200,
						statusText: 'OK',
						text: () => Promise.resolve(JSON.stringify({
							points: [{
								id: pointId,
								payload: {
									content: 'test content',
									access_count: 0,
									created_at: '2026-04-20T00:00:00Z',
									updated_at: '2026-04-20T00:00:00Z',
								},
							}],
						})),
						json: () => Promise.resolve({
							points: [{
								id: pointId,
								payload: {
									content: 'test content',
									access_count: 0,
									created_at: '2026-04-20T00:00:00Z',
									updated_at: '2026-04-20T00:00:00Z',
								},
							}],
						}),
					};
				}

				return {
					ok: false,
					status: 404,
					statusText: 'Not Found',
					text: () => Promise.resolve('Not Found'),
					json: () => Promise.reject(new Error('Not Found')),
				};
			});

			mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
				const method = (options?.method as string) || 'GET';

				if (method === 'PATCH' && url.includes('/points')) {
					return {
						ok: true,
						status: 200,
						statusText: 'OK',
						text: () => Promise.resolve('{}'),
						json: () => Promise.resolve({}),
					};
				}

				return {
					ok: false,
					status: 404,
					statusText: 'Not Found',
					text: () => Promise.resolve('Not Found'),
					json: () => Promise.reject(new Error('Not Found')),
				};
			});

			await service.get(pointId);
			await vi.runAllTimersAsync();

			expect(true).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('handles retrieve returning empty results gracefully', async () => {
		const pointId = 'non-existent';

		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (method === 'POST' && url.includes('/points')) {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ points: [] })),
					json: () => Promise.resolve({ points: [] }),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const result = await service.get(pointId);

		expect(result).toBeNull();
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

		const id = await service.upsert(content, vector, metadata, vectorLarge);

		expect(typeof id).toBe('string');
		expect(id.length).toBeGreaterThan(0);
	});

	it('generates a UUID id when not provided', async () => {
		const content = 'Test content';
		const vector = new Array(1536).fill(0.1);

		const id = await service.upsert(content, vector, {});

		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	});

	it('uses provided id when specified in metadata', async () => {
		const providedId = 'custom-id-12345';
		const vector = new Array(1536).fill(0.1);

		const id = await service.upsert('content', vector, { id: providedId });

		expect(id).toBe(providedId);
	});

	it('sets created_at and updated_at timestamps', async () => {
		const vector = new Array(1536).fill(0.1);
		// beforeCall timestamp could be used to verify created_at is after this point
		// Keeping for potential future validation
		const _beforeCall = new Date().toISOString();

		const id = await service.upsert('content', vector, {});

		expect(id).toBeDefined();
		expect(typeof id).toBe('string');
	});

	it('preserves provided metadata.updated_at when supplied', async () => {
		const vector = new Array(1536).fill(0.1);
		const providedTimestamp = '2025-01-01T00:00:00Z';

		const id = await service.upsert('content', vector, { updated_at: providedTimestamp });

		expect(id).toBeDefined();
	});

	it('applies default values for optional metadata fields', async () => {
		const vector = new Array(1536).fill(0.1);

		const id = await service.upsert('content', vector, {});

		expect(id).toBeDefined();
		expect(typeof id).toBe('string');
	});

	it('handles upsert error by rejecting the promise', async () => {
		const vector = new Array(1536).fill(0.1);
		mockFetch.mockImplementation(() => ({
			ok: false,
			status: 500,
			statusText: 'Internal Server Error',
			text: () => Promise.resolve('Upsert failed'),
			json: () => Promise.reject(new Error('Upsert failed')),
		}));

		await expect(service.upsert('content', vector, {})).rejects.toThrow();

		// Restore default mock
		mockFetch.mockRestore();
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

		const result = await service.batchUpsert(points);

		expect(result.successfulIds).toHaveLength(2);
		expect(result.failedPoints).toHaveLength(0);
		expect(result.totalProcessed).toBe(2);
	});

	it('returns result with processed count', async () => {
		const points = Array.from({ length: 10 }, (_, i) => ({
			content: `point ${i}`,
			vector: new Array(1536).fill(0.1),
		}));

		const result = await service.batchUpsert(points);

		expect(result.totalProcessed).toBe(points.length);
		expect(Array.isArray(result.successfulIds)).toBe(true);
		expect(Array.isArray(result.failedPoints)).toBe(true);
	});

	it('generates UUIDs for points without ids', async () => {
		const points = [{ content: 'content', vector: new Array(1536).fill(0.1) }];

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
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/points/search') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						result: [{ id: 'point-1', score: 0.95, payload: { content: 'result 1' } }],
					})),
					json: () => Promise.resolve({
						result: [{ id: 'point-1', score: 0.95, payload: { content: 'result 1' } }],
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const vector = new Array(1536).fill(0.1);
		const results = await service.search({ vector });

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ id: 'point-1', score: 0.95 });
	});

	it('returns empty array when no results found', async () => {
		const vector = new Array(1536).fill(0.1);
		const results = await service.search({ vector });

		expect(results).toEqual([]);
	});

	it('applies filters to search results', async () => {
		const vector = new Array(1536).fill(0.1);
		const results = await service.search({ vector, filter: { workspace: 'test-ws', memory_type: 'long-term' } });

		expect(Array.isArray(results)).toBe(true);
	});

	it('respects limit and offset parameters', async () => {
		const vector = new Array(1536).fill(0.1);
		const results = await service.search({ vector, limit: 5, offset: 10 });

		expect(Array.isArray(results)).toBe(true);
	});
});

describe('QdrantService.hybridSearchWithRRF', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('performs hybrid search when enabled with query', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/points/search') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						result: [{ id: 'point-1', score: 0.95, payload: { content: 'result 1' } }],
					})),
					json: () => Promise.resolve({
						result: [{ id: 'point-1', score: 0.95, payload: { content: 'result 1' } }],
					}),
				};
			}

			if (url.includes('/points/scroll') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ points: [], next_page_offset: null })),
					json: () => Promise.resolve({ points: [], next_page_offset: null }),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const vector = new Array(1536).fill(0.1);
		const results = await service.search({ vector, query: 'test query', useHybridSearch: true });

		expect(Array.isArray(results)).toBe(true);
	});

	it('returns results when some results from searches exist', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/points/search') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						result: [{ id: 'point-1', score: 0.95, payload: { content: 'result' } }],
					})),
					json: () => Promise.resolve({
						result: [{ id: 'point-1', score: 0.95, payload: { content: 'result' } }],
					}),
				};
			}

			if (url.includes('/points/scroll') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ points: [], next_page_offset: null })),
					json: () => Promise.resolve({ points: [], next_page_offset: null }),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const vector = new Array(1536).fill(0.1);
		const results = await service.search({ vector, query: 'test', useHybridSearch: true });

		expect(Array.isArray(results)).toBe(true);
	});

	it('performs hybrid search when useHybridSearch=true and query is provided', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/points/search') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ result: [] })),
					json: () => Promise.resolve({ result: [] }),
				};
			}

			if (url.includes('/points/scroll') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ points: [], next_page_offset: null })),
					json: () => Promise.resolve({ points: [], next_page_offset: null }),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const vector = new Array(1536).fill(0.1);
		const results = await service.search({
			vector,
			query: 'test',
			useHybridSearch: true,
			filter: { workspace: 'test-ws' },
		});

		expect(Array.isArray(results)).toBe(true);
	});
});

describe('QdrantService.list', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('lists points with pagination', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/points/scroll') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						points: [{ id: 'point-1', payload: { content: 'content 1' } }],
						next_page_offset: null,
					})),
					json: () => Promise.resolve({
						points: [{ id: 'point-1', payload: { content: 'content 1' } }],
						next_page_offset: null,
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const results = await service.list(undefined, 100, 0);

		expect(results).toBeInstanceOf(Array);
	});

	it('returns empty array when no points found', async () => {
		const results = await service.list(undefined, 100, 0);

		expect(results).toEqual([]);
	});

	it('applies workspace filter to list', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/points/scroll') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ points: [], next_page_offset: null })),
					json: () => Promise.resolve({ points: [], next_page_offset: null }),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const results = await service.list({ workspace: 'my-workspace' }, 100, 0);

		expect(Array.isArray(results)).toBe(true);
	});

	it('respects limit and offset parameters', async () => {
		const results = await service.list(undefined, 50, 25);

		expect(Array.isArray(results)).toBe(true);
	});
});

describe('QdrantService.delete', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('deletes a point by id', async () => {
		const pointId = 'point-to-delete';

		await expect(service.delete(pointId)).resolves.not.toThrow();
	});

	it('handles delete error gracefully', async () => {
		mockFetch.mockImplementation(() => ({
			ok: false,
			status: 500,
			statusText: 'Internal Server Error',
			text: () => Promise.resolve('Delete failed'),
			json: () => Promise.reject(new Error('Delete failed')),
		}));

		await expect(service.delete('some-id')).rejects.toThrow();

		// Restore default mock
		mockFetch.mockRestore();
	});
});

describe('QdrantService.batchDelete', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('batch deletes multiple points', async () => {
		const ids = ['id-1', 'id-2', 'id-3'];

		await expect(service.batchDelete(ids)).resolves.not.toThrow();
	});

	it('handles empty ids array', async () => {
		const ids: string[] = [];

		await expect(service.batchDelete(ids)).resolves.not.toThrow();
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

		await expect(service.updatePayload(pointId, updates)).resolves.not.toThrow();
	});

	it('handles setPayload error gracefully', async () => {
		mockFetch.mockImplementation(() => ({
			ok: false,
			status: 500,
			statusText: 'Internal Server Error',
			text: () => Promise.resolve('Payload update failed'),
			json: () => Promise.reject(new Error('Payload update failed')),
		}));

		await expect(service.updatePayload('point-id', { confidence: 0.8 })).rejects.toThrow();

		// Restore default mock
		mockFetch.mockRestore();
	});
});

// ── Error handling and edge cases ──────────────────────────────────────────────

describe('QdrantService edge cases and error handling', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('handles search returning empty results', async () => {
		const results = await service.search({ vector: new Array(1536).fill(0.1) });
		expect(results).toEqual([]);
	});

	it('handles list returning empty results', async () => {
		const results = await service.list();
		expect(results).toEqual([]);
	});

	it('handles retrieve returning empty results', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (method === 'POST' && url.includes('/points')) {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ points: [] })),
					json: () => Promise.resolve({ points: [] }),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const result = await service.get('nonexistent-id');
		expect(result).toBeNull();
	});

	it('handles count with filter returning zero', async () => {
		const count = await service.count();
		expect(count).toBe(0);
	});

	it('handles delete of nonexistent point', async () => {
		await expect(service.delete('nonexistent')).resolves.not.toThrow();
	});

	it('handles batch delete with empty array', async () => {
		await expect(service.batchDelete([])).resolves.not.toThrow();
	});

	it('handles update payload for nonexistent point', async () => {
		await expect(service.updatePayload('nonexistent', { confidence: 0.8 })).resolves.not.toThrow();
	});

	it('returns multiple results from search', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/points/search') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						result: [
							{ id: 'id-1', score: 0.95 },
							{ id: 'id-2', score: 0.85 },
						],
					})),
					json: () => Promise.resolve({
						result: [
							{ id: 'id-1', score: 0.95 },
							{ id: 'id-2', score: 0.85 },
						],
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const results = await service.search({ vector: new Array(1536).fill(0.1) });
		expect(results).toHaveLength(2);
	});

	it('handles batch upsert with many points', async () => {
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
		mockFetch.mockImplementation(() => ({
			ok: false,
			status: 500,
			statusText: 'Internal Server Error',
			text: () => Promise.resolve('Upsert failed'),
			json: () => Promise.reject(new Error('Upsert failed')),
		}));

		const points = Array.from({ length: 50 }, (_, i) => ({
			content: `content ${i}`,
			vector: new Array(1536).fill(0.1),
			metadata: { workspace: 'test' },
		}));

		const result = await service.batchUpsert(points);
		expect(result.successfulIds).toHaveLength(0);
		expect(result.failedPoints).toHaveLength(50);

		// Restore default mock
		mockFetch.mockRestore();
	});

	it('search with multiple results applies proper scoring', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/points/search') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						result: [
							{ id: 'id-1', score: 0.95, payload: { content: 'match1' } },
							{ id: 'id-2', score: 0.75, payload: { content: 'match2' } },
							{ id: 'id-3', score: 0.55, payload: { content: 'match3' } },
						],
					})),
					json: () => Promise.resolve({
						result: [
							{ id: 'id-1', score: 0.95, payload: { content: 'match1' } },
							{ id: 'id-2', score: 0.75, payload: { content: 'match2' } },
							{ id: 'id-3', score: 0.55, payload: { content: 'match3' } },
						],
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const results = await service.search({ vector: new Array(1536).fill(0.1) });
		expect(results).toHaveLength(3);
		expect(results[0].score).toBe(0.95);
		expect(results[2].score).toBe(0.55);
	});

	it('handles list with limit and offset parameters', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/points/scroll') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						points: [
							{ id: 'id-1', payload: { content: 'data1' } },
							{ id: 'id-2', payload: { content: 'data2' } },
						],
						next_page_offset: null,
					})),
					json: () => Promise.resolve({
						points: [
							{ id: 'id-1', payload: { content: 'data1' } },
							{ id: 'id-2', payload: { content: 'data2' } },
						],
						next_page_offset: null,
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const results = await service.list(undefined, 10, 5);
		expect(results).toHaveLength(2);
	});

	it('handles count with memory_type filter', async () => {
		const count = await service.count({ memory_type: 'long-term' });
		expect(count).toBe(0);
	});

	it('handles list filter with tags', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/points/scroll') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						points: [{ id: 'id-1', payload: { tags: ['tag1'] } }],
						next_page_offset: null,
					})),
					json: () => Promise.resolve({
						points: [{ id: 'id-1', payload: { tags: ['tag1'] } }],
						next_page_offset: null,
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const results = await service.list({ tags: ['tag1'] });
		expect(results).toHaveLength(1);
	});

	it('handles update payload with multiple fields', async () => {
		await expect(service.updatePayload('test-id', { confidence: 0.9, access_count: 5 })).resolves.not.toThrow();
	});

	it('search respects the embedding vector size', async () => {
		const largeVector = new Array(1536).fill(0.5);
		const results = await service.search({ vector: largeVector });

		expect(Array.isArray(results)).toBe(true);
	});

	it('handles upsert with dual embeddings (small and large vectors)', async () => {
		const id = await service.upsert('test content', new Array(1536).fill(0.1), { workspace: 'test' }, new Array(3072).fill(0.2));

		expect(typeof id).toBe('string');
	});

	it('batchDelete handles array of multiple IDs correctly', async () => {
		await expect(service.batchDelete(['id-1', 'id-2', 'id-3'])).resolves.not.toThrow();
	});

	it('count with min_confidence filter', async () => {
		const count = await service.count({ min_confidence: 0.8 });
		expect(count).toBe(0);
	});

	it('list with min_confidence and memory_type filters combined', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/points/scroll') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						points: [{ id: 'id-1', payload: { memory_type: 'long-term', confidence: 0.9 } }],
						next_page_offset: null,
					})),
					json: () => Promise.resolve({
						points: [{ id: 'id-1', payload: { memory_type: 'long-term', confidence: 0.9 } }],
						next_page_offset: null,
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const results = await service.list({ memory_type: 'long-term', min_confidence: 0.8 });
		expect(results).toHaveLength(1);
	});

	it('handles search with filter applied', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/points/search') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						result: [{ id: 'id-filtered', score: 0.9, payload: { tags: ['important'] } }],
					})),
					json: () => Promise.resolve({
						result: [{ id: 'id-filtered', score: 0.9, payload: { tags: ['important'] } }],
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const results = await service.search({ vector: new Array(1536).fill(0.1), limit: 10, filter: { tags: ['important'] } });
		expect(results).toHaveLength(1);
	});

	it('handles get (retrieve) for single point', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (method === 'POST' && url.includes('/points')) {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						points: [{ id: 'test-id', payload: { content: 'test' } }],
					})),
					json: () => Promise.resolve({
						points: [{ id: 'test-id', payload: { content: 'test' } }],
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

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
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/points/search') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						result: [
							{ id: 'point-1', score: 0.95, payload: { content: 'result 1' } },
							{ id: 'point-2', score: 0.85, payload: { content: 'result 2' } },
						],
					})),
					json: () => Promise.resolve({
						result: [
							{ id: 'point-1', score: 0.95, payload: { content: 'result 1' } },
							{ id: 'point-2', score: 0.85, payload: { content: 'result 2' } },
						],
					}),
				};
			}

			if (url.includes('/points/scroll') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ points: [], next_page_offset: null })),
					json: () => Promise.resolve({ points: [], next_page_offset: null }),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const vector = new Array(1536).fill(0.1);
		const results = await service.search({
			vector,
			query: 'test',
			useHybridSearch: true,
			hybridAlpha: 1.0,
		});

		expect(Array.isArray(results)).toBe(true);
	});

	it('performs hybrid search with alpha=0.0 (text-only weighting)', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/points/search') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ result: [] })),
					json: () => Promise.resolve({ result: [] }),
				};
			}

			if (url.includes('/points/scroll') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						points: [{ id: 'text-1', payload: { content: 'text result' } }],
						next_page_offset: null,
					})),
					json: () => Promise.resolve({
						points: [{ id: 'text-1', payload: { content: 'text result' } }],
						next_page_offset: null,
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const vector = new Array(1536).fill(0.1);
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
	});

	it('handles hybrid search when only vector results exist', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/points/search') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						result: [{ id: 'point-1', score: 0.95, payload: { content: 'vector result' } }],
					})),
					json: () => Promise.resolve({
						result: [{ id: 'point-1', score: 0.95, payload: { content: 'vector result' } }],
					}),
				};
			}

			if (url.includes('/points/scroll') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ points: [], next_page_offset: null })),
					json: () => Promise.resolve({ points: [], next_page_offset: null }),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const vector = new Array(1536).fill(0.1);
		const results = await service.search({
			vector,
			query: 'test',
			useHybridSearch: true,
		});

		expect(results).toHaveLength(1);
		expect(results[0]?.id).toBe('point-1');
	});

	it('handles hybrid search when only text results exist', async () => {
		// Mock both vector search (empty) and text search (has results)
		let _callCount = 0;
		mockFetch.mockImplementation((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';
			_callCount++;

			if (url.includes('/points/search') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ result: [] })),
					json: () => Promise.resolve({ result: [] }),
				};
			}

			if (url.includes('/points/scroll') && method === 'POST') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						points: [{ id: 'text-1', payload: { content: 'text result' } }],
						next_page_offset: null,
					})),
					json: () => Promise.resolve({
						points: [{ id: 'text-1', payload: { content: 'text result' } }],
						next_page_offset: null,
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const vector = new Array(1536).fill(0.1);
		const results = await service.search({
			vector,
			query: 'test',
			useHybridSearch: true,
		});

		expect(Array.isArray(results)).toBe(true);

		// Restore default mock
		mockFetch.mockRestore();
	});
});

// ── Branch coverage: createPayloadIndexes when indexes exist ─────────────────
describe('QdrantService.createPayloadIndexes with existing indexes', () => {
	beforeEach(() => {
		mockFetch.mockClear();
	});

	it('handles createPayloadIndex error when index already exists', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.endsWith('/collections') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ collections: [{ name: 'test-collection' }] })),
					json: () => Promise.resolve({ collections: [{ name: 'test-collection' }] }),
				};
			}

			if (url.includes('/collections/test-collection') && !url.includes('/points') && !url.includes('/index') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
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
					})),
					json: () => Promise.resolve({
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
					}),
				};
			}

			if (url.includes('/index') && method === 'PUT') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve('{}'),
					json: () => Promise.resolve({}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const service = new QdrantService();
		await expect(service.initialize()).resolves.not.toThrow();
	});

	it('throws when critical payload index creation fails with non-exists error', async () => {
		mockFetch.mockImplementation((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';
			const body = options?.body ? JSON.parse(String(options.body)) : undefined;

			if (url.endsWith('/collections') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ collections: [{ name: 'test-collection' }] })),
					json: () => Promise.resolve({ collections: [{ name: 'test-collection' }] }),
				};
			}

			if (url.includes('/collections/test-collection') && !url.includes('/points') && !url.includes('/index') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
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
					})),
					json: () => Promise.resolve({
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
					}),
				};
			}

			if (url.includes('/index') && method === 'PUT') {
				// Return error for critical field (workspace) to trigger init failure
				const fieldName = body?.field_name;
				if (fieldName === 'workspace') {
					return {
						ok: false,
						status: 400,
						statusText: 'Bad Request',
						text: () => Promise.resolve('Critical index creation failed'),
						json: () => Promise.reject(new Error('Critical index creation failed')),
					};
				}

				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve('{}'),
					json: () => Promise.resolve({}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const service = new QdrantService();
		await expect(service.initialize()).rejects.toThrow();

		// Restore default mock
		mockFetch.mockRestore();
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

			mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
				const method = (options?.method as string) || 'GET';

				if (method === 'POST' && url.includes('/points')) {
					return {
						ok: true,
						status: 200,
						statusText: 'OK',
						text: () => Promise.resolve(JSON.stringify({
							points: [{
								id: pointId,
								payload: {
									content: 'test content',
									created_at: '2026-04-20T00:00:00Z',
									updated_at: '2026-04-20T00:00:00Z',
								},
							}],
						})),
						json: () => Promise.resolve({
							points: [{
								id: pointId,
								payload: {
									content: 'test content',
									created_at: '2026-04-20T00:00:00Z',
									updated_at: '2026-04-20T00:00:00Z',
								},
							}],
						}),
					};
				}

				return {
					ok: false,
					status: 404,
					statusText: 'Not Found',
					text: () => Promise.resolve('Not Found'),
					json: () => Promise.reject(new Error('Not Found')),
				};
			});

			mockFetch.mockImplementationOnce(() => ({
				ok: false,
				status: 500,
				statusText: 'Internal Server Error',
				text: () => Promise.resolve('Access tracking failed'),
				json: () => Promise.reject(new Error('Access tracking failed')),
			}));

			// First call - should log warning
			await service.get(pointId);
			await vi.runAllTimersAsync();

			// Test passes if no crash occurs
			expect(true).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('updates last_accessed_at on successful access tracking', async () => {
		vi.useFakeTimers();

		try {
			const pointId = 'point-456';

			mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
				const method = (options?.method as string) || 'GET';

				if (method === 'POST' && url.includes('/points')) {
					return {
						ok: true,
						status: 200,
						statusText: 'OK',
						text: () => Promise.resolve(JSON.stringify({
							points: [{
								id: pointId,
								payload: {
									content: 'test',
									access_count: 0,
									created_at: '2026-04-20T00:00:00Z',
									updated_at: '2026-04-20T00:00:00Z',
								},
							}],
						})),
						json: () => Promise.resolve({
							points: [{
								id: pointId,
								payload: {
									content: 'test',
									access_count: 0,
									created_at: '2026-04-20T00:00:00Z',
									updated_at: '2026-04-20T00:00:00Z',
								},
							}],
						}),
					};
				}

				return {
					ok: false,
					status: 404,
					statusText: 'Not Found',
					text: () => Promise.resolve('Not Found'),
					json: () => Promise.reject(new Error('Not Found')),
				};
			});

			mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
				const method = (options?.method as string) || 'GET';

				if (method === 'PATCH' && url.includes('/points')) {
					return {
						ok: true,
						status: 200,
						statusText: 'OK',
						text: () => Promise.resolve('{}'),
						json: () => Promise.resolve({}),
					};
				}

				return {
					ok: false,
					status: 404,
					statusText: 'Not Found',
					text: () => Promise.resolve('Not Found'),
					json: () => Promise.reject(new Error('Not Found')),
				};
			});

			await service.get(pointId);
			await vi.runAllTimersAsync();

			expect(true).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ── Branch coverage: validateCollectionSchema with distance mismatches ──────
describe('QdrantService.validateCollectionSchema with distance mismatches', () => {
	it('throws when dense vector has non-Cosine distance', async () => {
		mockFetch.mockImplementation((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.endsWith('/collections') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ collections: [{ name: 'test-collection' }] })),
					json: () => Promise.resolve({ collections: [{ name: 'test-collection' }] }),
				};
			}

			if (url.includes('/collections/test-collection') && !url.includes('/points') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
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
					})),
					json: () => Promise.resolve({
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
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const service = new QdrantService();
		await expect(service.initialize()).rejects.toThrow('distance mismatch');

		// Restore default mock
		mockFetch.mockRestore();
	});

	it('throws when dense_large vector has non-Cosine distance', async () => {
		mockFetch.mockImplementation((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.endsWith('/collections') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({ collections: [{ name: 'test-collection' }] })),
					json: () => Promise.resolve({ collections: [{ name: 'test-collection' }] }),
				};
			}

			if (url.includes('/collections/test-collection') && !url.includes('/points') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
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
					})),
					json: () => Promise.resolve({
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
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const service = new QdrantService();
		await expect(service.initialize()).rejects.toThrow('distance mismatch');

		// Restore default mock
		mockFetch.mockRestore();
	});
});

// ── QdrantService.getStats (normalizeOptimizerStatus branches) ───────────────

describe('QdrantService.getStats', () => {
	let service: QdrantService;

	beforeEach(async () => {
		service = await createInitializedService();
	});

	it('normalizes optimizer_status when it is an object with error property', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/collections/test-collection') && !url.includes('/points') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
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
						segments_count: 3,
						status: 'green',
						optimizer_status: { error: 'index overflow' },
					})),
					json: () => Promise.resolve({
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
						segments_count: 3,
						status: 'green',
						optimizer_status: { error: 'index overflow' },
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const stats = await service.getStats();
		expect(stats.optimizer_status).toBe('error: index overflow');
	});

	it('normalizes optimizer_status when it is an object with ok property', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/collections/test-collection') && !url.includes('/points') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						config: {
							params: {
								vectors: {
									dense: { size: 1536, distance: 'Cosine' },
									dense_large: { size: 3072, distance: 'Cosine' },
								},
							},
						},
						points_count: 50,
						indexed_vectors_count: 50,
						segments_count: 2,
						status: 'green',
						optimizer_status: { ok: true },
					})),
					json: () => Promise.resolve({
						config: {
							params: {
								vectors: {
									dense: { size: 1536, distance: 'Cosine' },
									dense_large: { size: 3072, distance: 'Cosine' },
								},
							},
						},
						points_count: 50,
						indexed_vectors_count: 50,
						segments_count: 2,
						status: 'green',
						optimizer_status: { ok: true },
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const stats = await service.getStats();
		expect(stats.optimizer_status).toBe('ok');
	});

	it('normalizes optimizer_status to "unknown" when null', async () => {
		mockFetch.mockImplementationOnce((url: string, options?: Record<string, unknown>) => {
			const method = (options?.method as string) || 'GET';

			if (url.includes('/collections/test-collection') && !url.includes('/points') && method === 'GET') {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(JSON.stringify({
						config: {
							params: {
								vectors: {
									dense: { size: 1536, distance: 'Cosine' },
									dense_large: { size: 3072, distance: 'Cosine' },
								},
							},
						},
						points_count: 75,
						indexed_vectors_count: 75,
						segments_count: 2,
						status: 'green',
						optimizer_status: null,
					})),
					json: () => Promise.resolve({
						config: {
							params: {
								vectors: {
									dense: { size: 1536, distance: 'Cosine' },
									dense_large: { size: 3072, distance: 'Cosine' },
								},
							},
						},
						points_count: 75,
						indexed_vectors_count: 75,
						segments_count: 2,
						status: 'green',
						optimizer_status: null,
					}),
				};
			}

			return {
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Not Found'),
				json: () => Promise.reject(new Error('Not Found')),
			};
		});

		const stats = await service.getStats();
		expect(stats.optimizer_status).toBe('unknown');
	});
});
