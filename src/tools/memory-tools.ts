/**
 * Memory MCP Tools
 *
 * Core memory operations: store, query, list, get, update, delete
 */

import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { MCPTool, StandardResponse, SearchResult } from '../types/index.js';
import { successResponse, errorResponse, validationError, notFoundError } from '../utils/response.js';
import { config } from '../config.js';
import { extractErrorMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { qdrantService } from '../services/qdrant-client.js';
import { embeddingService } from '../services/embedding-service.js';
import { workspaceDetector } from '../services/workspace-detector.js';
import { isSafeToStore, getSecretsSummary } from '../services/secrets-detector.js';
import {
	MemoryStoreInputSchema,
	MemoryQueryInputSchema,
	MemoryListInputSchema,
	MemoryGetInputSchema,
	MemoryUpdateInputSchema,
	MemoryDeleteInputSchema,
	MemoryBatchDeleteInputSchema,
	MemoryStatusInputSchema,
	MemoryCountInputSchema,
	memorySchemas,
} from '../schemas/memory-schemas.js';

/** Expiry in days for episodic memories. */
const EPISODIC_EXPIRY_DAYS = 90;
/** Expiry in days for short-term memories. */
const SHORT_TERM_EXPIRY_DAYS = 7;
/** Character limit for content preview in list responses. */
const CONTENT_PREVIEW_LENGTH = 200;

/** Max characters of query shown in debug logs. */
const QUERY_LOG_LENGTH = 50;
/** Max records to sort in memory (beyond this, warn and cap). */
const MAX_IN_MEMORY_SORT_COUNT = 10000;

/**
 * Memory Store Tool
 */

/**
 * Checks content for secrets and sensitive information before storage.
 *
 * Uses a two-path logic: high-confidence detections (API keys, private keys, etc.) block storage
 * immediately; low/medium-confidence patterns (passwords, tokens) block only if 3+ distinct matches
 * are found. Medium-confidence matches without a block threshold log warnings for transparency.
 *
 * @param content - The content string to check for sensitive patterns.
 * @param idContext - Optional memory ID for error reporting context.
 * @returns StandardResponse | null - An error StandardResponse if unsafe content is detected (safe=false), null if storage is permitted.
 * @throws Does not throw; all safety violations return an error response or null.
 * @example
 * ```typescript
 * const error = checkContentSecrets('API key: sk-abc123...');
 * if (error) {
 *   logger.warn('Storage blocked:', error.message);
 * }
 * ```
 */
function checkContentSecrets(content: string, idContext?: string): StandardResponse | null {
	const safetyCheck = isSafeToStore(content);
	if (!safetyCheck.safe) {
		logger.warn(`Blocked memory operation: ${safetyCheck.reason}`);
		const secretsList = safetyCheck.secrets?.map(s => ({
			type: s.type,
			pattern: s.pattern,
			confidence: s.confidence,
			context: s.context,
		})) ?? [];
		return errorResponse(
			'Cannot store content containing sensitive information',
			'VALIDATION_ERROR',
			safetyCheck.reason,
			{
				...(idContext ? { id: idContext } : {}),
				error_code: 'SECRETS_DETECTED',
				secrets_detected: secretsList,
				summary: getSecretsSummary(safetyCheck.detection),
				suggestion: 'Remove sensitive data before storing. Use placeholders like [API_KEY] or [PASSWORD] instead.',
			},
		);
	}
	if (safetyCheck.reason && safetyCheck.secrets) {
		logger.warn(`Storing with warning: ${safetyCheck.reason}`);
	}
	return null;
}

/**
 * Normalizes the workspace metadata field to lowercase for consistent storage.
 *
 * Mutates the input object in-place by normalizing the workspace field through
 * WorkspaceDetector.normalize(). If workspace is null or undefined, it is left unchanged.
 * Returns the mutated object for convenience in chaining operations.
 *
 * @param metadata - The metadata object to normalize in-place. The workspace property (if present) will be transformed to lowercase.
 * @returns The same metadata object passed as input, with workspace normalized.
 * @throws Does not throw; silently skips normalization if workspace is null or undefined.
 * @example
 * ```typescript
 * const meta = { workspace: 'MyProject', memory_type: 'long-term' };
 * const result = normalizeWorkspaceInMetadata(meta);
 * // meta.workspace is now 'myproject' (mutated in-place)
 * // result === meta (same reference)
 * ```
 */
function normalizeWorkspaceInMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
	const ws = metadata.workspace;
	if (typeof ws === 'string' || ws === null) {
		metadata.workspace = workspaceDetector.normalize(ws);
	}
	return metadata;
}

/**
 * Handles the memory-store MCP tool — embeds and stores a memory, with automatic chunking for large content.
 *
 * Validates input, checks for secrets, auto-detects workspace, applies expiry based on memory_type,
 * and either stores as a single point or chunks long content (>1000 chars) across multiple embeddings.
 *
 * @param args - Validated MemoryStoreInput containing content, optional metadata, and auto_chunk flag.
 * @returns Promise resolving to a StandardResponse with stored memory ID(s) and metadata, or error.
 * @throws Never throws; returns errorResponse() on validation failure, secrets detection, or storage failure.
 * @example
 * ```typescript
 * const result = await memoryStoreHandler({ content: 'TypeScript uses structural typing.' });
 * // Returns: { success: true, data: { id: 'uuid', memory_type: 'long-term', workspace: 'default' } }
 * ```
 */
async function memoryStoreHandler(args: unknown): Promise<StandardResponse> {
	const startTime = Date.now();

	try {
		const input = MemoryStoreInputSchema.parse(args);
		logger.info('Storing memory...');

		// Validate workspace if provided
		if (input.metadata?.workspace !== undefined && input.metadata.workspace !== null && !workspaceDetector.isValidWorkspace(input.metadata.workspace)) {
			return validationError('Invalid workspace name');
		}

		// Check for secrets and sensitive information
		const secretsError = checkContentSecrets(input.content);
		if (secretsError) return secretsError;

		// Build a new metadata object (do not mutate input.metadata)
		const inputMeta = input.metadata ?? {};
		let expiresAt = inputMeta.expires_at;

		// Auto-set expires_at based on memory type (if not already provided).
		// Note: null from the caller means "explicitly no expiry" (skip auto-expiry logic);
		// undefined means "not provided" (apply auto-expiry by type).
		if (expiresAt === undefined) {
			const memoryType = inputMeta.memory_type;
			if (memoryType === 'episodic') {
				const expiry = new Date();
				expiry.setDate(expiry.getDate() + EPISODIC_EXPIRY_DAYS);
				expiresAt = expiry.toISOString();
			} else if (memoryType === 'short-term') {
				const expiry = new Date();
				expiry.setDate(expiry.getDate() + SHORT_TERM_EXPIRY_DAYS);
				expiresAt = expiry.toISOString();
			}
		}

		// Detect workspace if not provided
		let { workspace } = inputMeta;
		if (workspace === undefined) {
			const detected = workspaceDetector.detect();
			workspace = detected.workspace;
			logger.debug(`Detected workspace: ${workspace ?? 'none'}`);
		}

		// Normalize workspace to lowercase for consistent storage
		if (workspace !== null && workspace !== undefined) {
			workspace = workspaceDetector.normalize(workspace);
		}

		const metadata = { ...inputMeta, ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}), workspace };

		// Handle chunking for long content
		if (input.auto_chunk && input.content.length > config.memory.chunkSize) {
			const chunked = await embeddingService.generateChunkedEmbeddings(input.content);

			// All chunks share a common group ID so siblings can be found and managed together
			const chunkGroupId = uuidv4();

			// Batch large embedding generation across all chunks
			const largeEmbeddings = await embeddingService.generateBatchLargeEmbeddings(
				chunked.map(({ chunk }) => chunk),
			);

			// Batch upsert all chunks in a single operation
			const points = chunked.map(({ chunk, embedding, index, total }) => ({
				content: chunk,
				vector: embedding,
				vectorLarge: largeEmbeddings[index],
				metadata: { ...metadata, chunk_index: index, total_chunks: total, chunk_group_id: chunkGroupId },
			}));

			const batchResult = await qdrantService.batchUpsert(points);
			if (batchResult.failedPoints.length > 0) {
				// Best-effort cleanup to avoid orphaned chunks
				if (batchResult.successfulIds.length > 0) {
					try {
						await qdrantService.batchDelete(batchResult.successfulIds);
					} catch (cleanupError) {
						logger.warn('Failed to clean up orphaned chunks after partial batch failure', {
							cause: cleanupError,
						});
					}
				}
				return errorResponse(
					`Failed to store ${batchResult.failedPoints.length} chunks`,
					'EXECUTION_ERROR',
					`Failed point IDs: ${batchResult.failedPoints.map(p => p.id).join(', ')}`,
					{ successfulIds: batchResult.successfulIds },
				);
			}
			const ids = batchResult.successfulIds;

			logger.info(`Memory stored: ${ids.length} chunks`);

			return successResponse(
				'Memory stored successfully (chunked)',
				{ ids, chunks: chunked.length, memory_type: metadata.memory_type, workspace: metadata.workspace },
				{ duration_ms: Date.now() - startTime },
			);
		} else {
			const dual = await embeddingService.generateDualEmbeddings(input.content);
			const id = await qdrantService.upsert(input.content, dual.small, metadata, dual.large);

			logger.info(`Memory stored: ${id}`);

			return successResponse(
				'Memory stored successfully',
				{ id, memory_type: metadata.memory_type, workspace: metadata.workspace, confidence: metadata.confidence },
				{ duration_ms: Date.now() - startTime },
			);
		}
	} catch (error: unknown) {
		logger.error('Failed to store memory:', error);
		if (error instanceof z.ZodError) {
			return validationError('Invalid input parameters', error.issues);
		}
		return errorResponse('Failed to store memory', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Handles the memory-query MCP tool — searches memories by natural-language semantic similarity.
 *
 * Generates dual embeddings (small+large), searches via vector similarity with optional hybrid search
 * (RRF fusion of dense vectors and full-text index), and auto-injects workspace filter to match store behavior.
 *
 * @param args - Validated MemoryQueryInput with query string, optional filters, and search options.
 * @returns Promise resolving to StandardResponse with ranked results array (id, content, score, metadata).
 * @throws Never throws; returns errorResponse() on invalid input or search failure; rejects hybrid search with pagination.
 * @example
 * ```typescript
 * const result = await memoryQueryHandler({ query: 'how to use async/await', limit: 10 });
 * // Returns: { success: true, data: { results: [...], count: 3, query: '...' } }
 * ```
 */
async function memoryQueryHandler(args: unknown): Promise<StandardResponse> {
	const startTime = Date.now();

	try {
		const input = MemoryQueryInputSchema.parse(args);
		const queryPreview = input.query.slice(0, QUERY_LOG_LENGTH);
		const truncationSuffix = input.query.length > QUERY_LOG_LENGTH ? '...' : '';
		logger.info(`Querying memory: "${queryPreview}${truncationSuffix}"`);

		// Hybrid search does not support pagination
		if (input.use_hybrid_search && input.offset > 0) {
			return errorResponse(
				'Hybrid search does not support pagination. Use standard search for pagination.',
				'VALIDATION_ERROR',
			);
		}

		// Auto-inject workspace to filter if not explicitly provided (match store behavior)
		const { filter } = input;
		const detected = workspaceDetector.detect();
		let normalizedWorkspace = detected.workspace;
		if (filter?.workspace === undefined) {
			if (detected.workspace !== null && detected.workspace !== undefined) {
				normalizedWorkspace = workspaceDetector.normalize(detected.workspace);
				logger.debug(`Auto-injecting workspace filter: ${normalizedWorkspace}`);
			} else {
				logger.warn('No workspace detected; query will be limited to memories with null workspace');
			}
		}

		const dual = await embeddingService.generateDualEmbeddings(input.query);

		// Search Qdrant (with optional hybrid search using RRF)
		const results = await qdrantService.search({
			vector: dual.small,
			vectorLarge: dual.large,
			filter: {
				...filter,
				...(filter?.workspace === undefined
					? {
						// When no workspace is detected and none was explicitly requested, filter for
						// null-workspace memories. This is intentional: an undetected workspace implies
						// the caller is operating without workspace context, so scoping to null-workspace
						// memories avoids cross-contaminating results from other workspaces.
						workspace: normalizedWorkspace,
					}
					: {}),
			},
			limit: input.limit,
			offset: input.offset,
			scoreThreshold: input.score_threshold,
			hnsw_ef: input.hnsw_ef,
			useHybridSearch: input.use_hybrid_search,
			query: input.query,
			hybridAlpha: input.hybrid_alpha,
		});

		logger.info(`Query returned ${results.length} results`);

		return successResponse(
			`Found ${results.length} memories`,
			{
				results: results.map((r) => ({
					id: r.id,
					content: r.content,
					score: r.score,
					metadata: r.metadata,
				})),
				query: input.query,
				count: results.length,
			},
			{
				duration_ms: Date.now() - startTime,
			},
		);
	} catch (error: unknown) {
		logger.error('Failed to query memory:', error);
		if (error instanceof z.ZodError) {
			return validationError('Invalid input parameters', error.issues);
		}
		return errorResponse('Failed to query memory', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Handles the memory-list MCP tool — browses memories with pagination, filtering, and sorting.
 *
 * Fetches matching records from Qdrant with optional filtering by workspace/memory_type/tags,
 * sorts in-memory by requested field (created_at/updated_at/access_count/confidence),
 * and returns paginated results with content previews. Large result sets (>10,000 records) are
 * truncated with a warning; use filters to narrow results.
 *
 * @param args - Validated MemoryListInput with filter, sort_by, sort_order, limit, and offset.
 * @returns Promise resolving to StandardResponse with memories array (truncated content), total_count, and pagination metadata.
 * @throws Never throws; returns errorResponse() on invalid input or query failure.
 * @example
 * ```typescript
 * const result = await memoryListHandler({ limit: 20, offset: 0, sort_by: 'created_at', sort_order: 'desc' });
 * // Returns: { success: true, data: { memories: [...], count: 20, total_count: 150, limit: 20, offset: 0 } }
 * ```
 */
async function memoryListHandler(args: unknown): Promise<StandardResponse> {
	const startTime = Date.now();

	try {
		const input = MemoryListInputSchema.parse(args);
		logger.info('Listing memories...');

		// Determine fetch strategy based on sorting needs
		let results: SearchResult[];
		// NOTE: We fetch the total count upfront to:
		// 1) Determine the memory load for sort operations (MAX_IN_MEMORY_SORT_COUNT cap)
		// 2) Return total_count in the response to clients (pagination metadata)
		// This is necessary for the current API contract, but could be optimized by:
		// - Deferring count() until needed (only if sorting is requested)
		// - Implementing streaming pagination to avoid loading large result sets
		const totalCount = await qdrantService.count(input.filter);

		if (!input.sort_by || input.sort_by === 'created_at') {
			// Qdrant scroll returns results in internal order, not guaranteed to be sorted
			// For created_at, we must fetch all and sort in memory to ensure correct order
			const fetchLimit = Math.min(totalCount, MAX_IN_MEMORY_SORT_COUNT);
			if (totalCount > MAX_IN_MEMORY_SORT_COUNT) {
				logger.warn(
					`Sorting ${totalCount} records by created_at: only the first ${MAX_IN_MEMORY_SORT_COUNT} are loaded for performance. ` +
					'Results beyond this cap may be missing. Use filters to narrow the result set.',
				);
			}
			const allResults = await qdrantService.list(
				input.filter,
				fetchLimit,
				0,
			);

			// Sort by created_at with requested order
			const sortedResults = allResults.sort((a, b) => {
				const aTime = new Date(a.metadata?.created_at ?? 0).getTime();
				const bTime = new Date(b.metadata?.created_at ?? 0).getTime();
				if (input.sort_order === 'asc') {
					return aTime - bTime;
				} else {
					return bTime - aTime;
				}
			});

			// Apply offset and limit after sorting
			results = sortedResults.slice(input.offset, input.offset + input.limit);
		} else {
			// For other sort fields, we must fetch all matching records and sort in memory.
			// Fetching only limit+offset would produce incorrect results because Qdrant's
			// scroll order is internal — not the requested sort order.
			if (totalCount > MAX_IN_MEMORY_SORT_COUNT) {
				logger.warn(
					`Sorting ${totalCount} records: only the first ${MAX_IN_MEMORY_SORT_COUNT} are loaded for performance. ` +
					'Results beyond this cap may be missing. Use filters to narrow the result set.',
				);
			}
			const fetchLimit = Math.min(totalCount, MAX_IN_MEMORY_SORT_COUNT);
			const allResults = await qdrantService.list(
				input.filter,
				fetchLimit,
				0,
			);

			// Sort by requested field
			const sortedResults = allResults.sort((a, b) => {
				let aValue: number;
				let bValue: number;

				switch (input.sort_by) {
					case 'updated_at':
						aValue = new Date(a.metadata?.updated_at ?? 0).getTime();
						bValue = new Date(b.metadata?.updated_at ?? 0).getTime();
						break;
					case 'access_count':
						aValue = typeof a.metadata?.access_count === 'number' ? a.metadata.access_count : 0;
						bValue = typeof b.metadata?.access_count === 'number' ? b.metadata.access_count : 0;
						break;
					case 'confidence':
						aValue = typeof a.metadata?.confidence === 'number' ? a.metadata.confidence : 0;
						bValue = typeof b.metadata?.confidence === 'number' ? b.metadata.confidence : 0;
						break;
					default:
						aValue = new Date(a.metadata?.created_at ?? 0).getTime();
						bValue = new Date(b.metadata?.created_at ?? 0).getTime();
				}

				// Apply sort order
				if (input.sort_order === 'asc') {
					return aValue > bValue ? 1 : aValue < bValue ? -1 : 0;
				} else {
					return aValue < bValue ? 1 : aValue > bValue ? -1 : 0;
				}
			});

			// Apply offset and limit after sorting
			results = sortedResults.slice(input.offset, input.offset + input.limit);
		}

		logger.info(
			`Listed ${results.length} memories ` +
      `(sorted by ${input.sort_by ?? 'created_at'} ${input.sort_order})`,
		);

		const effectiveTotalCount = Math.min(totalCount, MAX_IN_MEMORY_SORT_COUNT);
		const isCapped = totalCount > MAX_IN_MEMORY_SORT_COUNT;

		return successResponse(
			`Listed ${results.length} memories`,
			{
				memories: results.map((r) => ({
					id: r.id,
					// Truncate for listing; append ellipsis so callers know the content was cut
					content: r.content.length > CONTENT_PREVIEW_LENGTH
						? `${r.content.slice(0, CONTENT_PREVIEW_LENGTH)}...`
						: r.content,
					metadata: r.metadata,
				})),
				count: results.length,
				total_count: effectiveTotalCount,
				limit: input.limit,
				offset: input.offset,
				...(isCapped ? { capped: true, uncapped_count: totalCount } : {}),
			},
			{
				duration_ms: Date.now() - startTime,
			},
		);
	} catch (error: unknown) {
		logger.error('Failed to list memories:', error);
		if (error instanceof z.ZodError) {
			return validationError('Invalid input parameters', error.issues);
		}
		return errorResponse('Failed to list memories', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Handles the memory-get MCP tool — retrieves a single memory by UUID with full content.
 *
 * Looks up the memory point by ID in Qdrant and returns complete content and metadata.
 *
 * @param args - Validated MemoryGetInput containing the memory UUID.
 * @returns Promise resolving to StandardResponse with id, full content, and metadata if found.
 * @throws Never throws; returns notFoundError() if memory ID does not exist.
 * @example
 * ```typescript
 * const result = await memoryGetHandler({ id: '550e8400-e29b-41d4-a716-446655440000' });
 * // Returns: { success: true, data: { id: '550e8400...', content: '...', metadata: {...} } }
 * ```
 */
async function memoryGetHandler(args: unknown): Promise<StandardResponse> {
	const startTime = Date.now();

	try {
		const input = MemoryGetInputSchema.parse(args);
		logger.info(`Getting memory: ${input.id}`);

		const result = await qdrantService.get(input.id);

		if (!result) {
			return notFoundError(`Memory with ID ${input.id}`);
		}

		logger.info(`Memory retrieved: ${input.id}`);

		return successResponse(
			'Memory retrieved successfully',
			{
				id: result.id,
				content: result.content,
				metadata: result.metadata,
			},
			{
				duration_ms: Date.now() - startTime,
			},
		);
	} catch (error: unknown) {
		logger.error('Failed to get memory:', error);
		if (error instanceof z.ZodError) {
			return validationError('Invalid input parameters', error.issues);
		}
		return errorResponse('Failed to get memory', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Handles the memory-update MCP tool — updates memory content and/or metadata with automatic re-chunking.
 *
 * Validates that at least one of content or metadata is provided, checks for secrets in new content,
 * and handles transparent re-chunking of chunked memories. Content updates trigger re-embedding and
 * re-indexing; metadata-only updates are atomic. Chunked memories (from store) are re-chunked as a unit
 * and sibling chunks are synchronized.
 *
 * @param args - Validated MemoryUpdateInput with id (required), optional new content and/or metadata.
 * @returns Promise resolving to StandardResponse with updated memory id, reindex status, and (if rechunked) chunk counts.
 * @throws Never throws; returns notFoundError() if memory does not exist, errorResponse() on validation or update failure.
 * @example
 * ```typescript
 * const result = await memoryUpdateHandler({ id: 'uuid', content: 'Updated content' });
 * // Returns: { success: true, data: { id: 'uuid', reindexed: true } }
 * ```
 */
async function memoryUpdateHandler(args: unknown): Promise<StandardResponse> {
	const startTime = Date.now();

	try {
		const input = MemoryUpdateInputSchema.parse(args);
		logger.info(`Updating memory: ${input.id}`);

		// Validate workspace if provided (check for non-null, non-undefined)
		if (input.metadata?.workspace !== undefined && input.metadata.workspace !== null && !workspaceDetector.isValidWorkspace(input.metadata.workspace)) {
			return validationError('Invalid workspace name');
		}

		// Validation: at least one of content or metadata must be provided
		const hasContent = input.content !== undefined;
		const hasMetadata = input.metadata && Object.keys(input.metadata).length > 0;
		if (!hasContent && !hasMetadata) {
			return validationError('metadata must contain at least one field, or provide new content');
		}

		// Check for secrets if content is being updated
		if (input.content !== undefined) {
			const secretsError = checkContentSecrets(input.content, input.id);
			if (secretsError) return secretsError;
		}

		// Get existing memory
		const existing = await qdrantService.get(input.id);
		if (!existing) {
			return notFoundError(`Memory with ID ${input.id}`);
		}

		// Handle updates to individual chunks of a chunked memory transparently
		if (existing.metadata?.chunk_index !== undefined) {
			const chunkGroupId = existing.metadata?.chunk_group_id;

			// Case A: Content update - re-chunk and re-store all siblings
			if (input.content) {
				// Find all siblings sharing the same chunk_group_id
				const siblings = chunkGroupId
					? await qdrantService.list({ metadata: { chunk_group_id: chunkGroupId } })
					: [{ id: input.id, metadata: existing.metadata }];

				const siblingIds = siblings.map(s => s.id);

				// Re-chunk and re-store with new content
				const baseMetadata = { ...existing.metadata };
				// Strip chunk-specific fields from base before overlaying input metadata
				baseMetadata.chunk_index = undefined;
				baseMetadata.total_chunks = undefined;
				baseMetadata.chunk_group_id = undefined;

				const mergedMetadata = { ...baseMetadata, ...input.metadata };

				// Normalize workspace to lowercase for consistent storage
				if (mergedMetadata.workspace !== null && mergedMetadata.workspace !== undefined) {
					mergedMetadata.workspace = workspaceDetector.normalize(mergedMetadata.workspace);
				}

				// Decide: chunk the new content or store as single?
				if (input.auto_chunk && input.content.length > config.memory.chunkSize) {
					const chunked = await embeddingService.generateChunkedEmbeddings(input.content);
					const newChunkGroupId = uuidv4();

					// Batch large embedding generation across all chunks
					const largeEmbeddings = await embeddingService.generateBatchLargeEmbeddings(
						chunked.map(({ chunk }) => chunk),
					);

					// Batch upsert all chunks in a single operation
					const points = chunked.map(({ chunk, embedding, index, total }) => ({
						content: chunk,
						vector: embedding,
						vectorLarge: largeEmbeddings[index],
						metadata: { ...mergedMetadata, chunk_index: index, total_chunks: total, chunk_group_id: newChunkGroupId },
					}));

					// Store new chunks BEFORE deleting old ones to prevent data loss if upsert fails
					const batchResult = await qdrantService.batchUpsert(points);
					if (batchResult.failedPoints.length > 0) {
						return errorResponse(
							`Failed to update ${batchResult.failedPoints.length} chunks`,
							'EXECUTION_ERROR',
							`Failed point IDs: ${batchResult.failedPoints.map(p => p.id).join(', ')}`,
							{ successfulIds: batchResult.successfulIds },
						);
					}
					const newIds = batchResult.successfulIds;

					// Validate that we have results before proceeding with deletion
					if (newIds.length === 0) {
						return errorResponse('Chunk update produced no results', 'EXECUTION_ERROR');
					}

					// Delete old chunks only after successful upsert of new chunks
					if (siblingIds.length > 0) {
						try {
							await qdrantService.batchDelete(siblingIds);
						} catch (deleteError) {
							// Log warning but still return success (new data is safe, old chunks become orphaned)
							logger.warn('Failed to delete old chunks after successful update', {
								cause: deleteError,
								oldChunkIds: siblingIds,
							});
						}
					}

					logger.info(`Chunked memory updated: re-stored ${newIds.length} chunks (deleted ${siblingIds.length} old chunks)`);

					return successResponse(
						'Chunked memory updated and re-stored',
						{
							id: newIds[0], // Return first chunk ID as representative
							chunks: newIds.length,
							old_chunks: siblingIds.length,
							chunk_group_id: newChunkGroupId,
						},
						{
							duration_ms: Date.now() - startTime,
						},
					);
				} else {
					// Store as a single memory (no chunking)
					const dual = await embeddingService.generateDualEmbeddings(input.content);
					const newId = await qdrantService.upsert(input.content, dual.small, mergedMetadata, dual.large);

					// Delete old chunks only after successful upsert of new memory
					if (siblingIds.length > 0) {
						try {
							await qdrantService.batchDelete(siblingIds);
						} catch (deleteError) {
							// Log warning but still return success (new data is safe, old chunks become orphaned)
							logger.warn('Failed to delete old chunks after successful update', {
								cause: deleteError,
								oldChunkIds: siblingIds,
							});
						}
					}

					logger.info(`Chunked memory updated: re-stored as single memory (deleted ${siblingIds.length} chunks)`);

					return successResponse(
						'Chunked memory updated and consolidated into single memory',
						{
							id: newId,
							old_chunks: siblingIds.length,
						},
						{
							duration_ms: Date.now() - startTime,
						},
					);
				}
			}

			// Case B: Metadata-only update - update all siblings
			if (chunkGroupId) {
				const siblings = await qdrantService.list({ metadata: { chunk_group_id: chunkGroupId } });

				const metadataToUpdateSiblings = { ...(input.metadata ?? {}) };
				normalizeWorkspaceInMetadata(metadataToUpdateSiblings);

				const results = await Promise.allSettled(
					siblings.map(sibling => qdrantService.updatePayload(sibling.id, metadataToUpdateSiblings)),
				);
				const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
				if (failures.length > 0) {
					logger.warn('Some sibling chunk metadata updates failed', {
						failedCount: failures.length,
						totalSiblings: siblings.length,
						errors: failures.map(f => String(f.reason)),
					});
				}

				logger.info(`Updated metadata across ${siblings.length} chunk siblings`);

				return successResponse(
					'Metadata updated across all chunk siblings',
					{
						id: input.id,
						siblings_updated: siblings.length - failures.length,
					},
					{
						duration_ms: Date.now() - startTime,
					},
				);
			} else {
				// No chunk_group_id, just update this chunk's metadata
				await qdrantService.updatePayload(input.id, input.metadata ?? {});

				logger.info(`Chunk metadata updated: ${input.id}`);

				return successResponse(
					'Chunk metadata updated',
					{
						id: input.id,
					},
					{
						duration_ms: Date.now() - startTime,
					},
				);
			}
		}

		// Content update: always reindex
		if (input.content !== undefined) {
			logger.debug('Re-generating dual embeddings for updated content');
			const dual = await embeddingService.generateDualEmbeddings(input.content);

			const mergedMetadata = {
				...existing.metadata,
				...input.metadata,
				// Preserve the original ID so the upsert overwrites the existing point atomically.
				// This is safe because Qdrant's upsert is idempotent — no delete needed.
				id: input.id,
			};

			normalizeWorkspaceInMetadata(mergedMetadata);

			await qdrantService.upsert(
				input.content,
				dual.small,
				mergedMetadata,
				dual.large,
			);

			logger.info(`Memory updated and reindexed: ${input.id}`);
		} else {
			// Metadata-only update
			const metadataToUpdate = { ...(input.metadata ?? {}) };
			normalizeWorkspaceInMetadata(metadataToUpdate);
			await qdrantService.updatePayload(input.id, metadataToUpdate);
			logger.info(`Memory metadata updated: ${input.id}`);
		}

		return successResponse(
			'Memory updated successfully',
			{
				id: input.id,
				reindexed: !!input.content,
			},
			{
				duration_ms: Date.now() - startTime,
			},
		);
	} catch (error: unknown) {
		logger.error('Failed to update memory:', error);
		if (error instanceof z.ZodError) {
			return validationError('Invalid input parameters', error.issues);
		}
		return errorResponse('Failed to update memory', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Handles the memory-delete MCP tool — deletes a single memory by UUID.
 *
 * Verifies the memory exists before deletion, then removes it from the Qdrant collection.
 *
 * @param args - Validated MemoryDeleteInput containing the memory UUID.
 * @returns Promise resolving to StandardResponse with deleted memory id.
 * @throws Never throws; returns notFoundError() if memory ID does not exist.
 * @example
 * ```typescript
 * const result = await memoryDeleteHandler({ id: '550e8400-e29b-41d4-a716-446655440000' });
 * // Returns: { success: true, data: { id: '550e8400...' } }
 * ```
 */
async function memoryDeleteHandler(args: unknown): Promise<StandardResponse> {
	const startTime = Date.now();

	try {
		const input = MemoryDeleteInputSchema.parse(args);
		logger.info(`Deleting memory: ${input.id}`);

		// Check if exists
		const existing = await qdrantService.get(input.id);
		if (!existing) {
			return notFoundError(`Memory with ID ${input.id}`);
		}

		await qdrantService.delete(input.id);

		logger.info(`Memory deleted: ${input.id}`);

		return successResponse(
			'Memory deleted successfully',
			{
				id: input.id,
			},
			{
				duration_ms: Date.now() - startTime,
			},
		);
	} catch (error: unknown) {
		logger.error('Failed to delete memory:', error);
		if (error instanceof z.ZodError) {
			return validationError('Invalid input parameters', error.issues);
		}
		return errorResponse('Failed to delete memory', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Handles the memory-batch-delete MCP tool — deletes up to 100 memories in a single operation.
 *
 * Unlike memory-delete, silently succeeds for non-existent IDs. The returned `count` reflects
 * the number of delete operations issued, not confirmed deletions (Qdrant returns success
 * for non-existent point deletions).
 *
 * @param args - Validated MemoryBatchDeleteInput with ids array (1–100 UUIDs).
 * @returns Promise resolving to StandardResponse with operation count and ids list.
 * @throws Never throws; returns errorResponse() only on invalid input or Qdrant connection failure.
 * @example
 * ```typescript
 * const result = await memoryBatchDeleteHandler({ ids: ['uuid1', 'uuid2'] });
 * // Returns: { success: true, data: { count: 2, ids: ['uuid1', 'uuid2'] } }
 * ```
 */
async function memoryBatchDeleteHandler(args: unknown): Promise<StandardResponse> {
	const startTime = Date.now();

	try {
		const input = MemoryBatchDeleteInputSchema.parse(args);
		logger.info(`Batch deleting memories: ${input.ids.length} IDs`);

		await qdrantService.batchDelete(input.ids);

		logger.info(`Batch delete completed: ${input.ids.length} memories`);

		return successResponse(
			`Deleted ${input.ids.length} memories`,
			{
				count: input.ids.length,
				ids: input.ids,
			},
			{
				duration_ms: Date.now() - startTime,
			},
		);
	} catch (error: unknown) {
		logger.error('Failed to batch delete memories:', error);
		if (error instanceof z.ZodError) {
			return validationError('Invalid input parameters', error.issues);
		}
		return errorResponse('Failed to batch delete memories', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Handles the memory-status MCP tool — returns server health, collection statistics, and optional embedding cost data.
 *
 * Retrieves Qdrant collection stats (points count, segments, indexing status), counts memories
 * by type (episodic/short-term/long-term), optionally workspace-scoped, and includes embedding API
 * statistics (calls, tokens, costs, cache hit rate) when requested.
 *
 * @param args - Validated MemoryStatusInput with optional workspace filter and embedding stats flag.
 * @returns Promise resolving to StandardResponse with server name, timestamp, collection health, type counts, and optional embedding stats.
 * @throws Never throws; returns errorResponse() on invalid input or Qdrant connection failure.
 * @example
 * ```typescript
 * const result = await memoryStatusHandler({ include_embedding_stats: true });
 * // Returns: { success: true, data: { server: 'mcp-memory', collection: {...}, by_type: {...}, embeddings: {...} } }
 * ```
 */
async function memoryStatusHandler(args: unknown): Promise<StandardResponse> {
	const startTime = Date.now();

	try {
		const input = MemoryStatusInputSchema.parse(args);
		logger.info('Getting memory status...');

		// Get Qdrant stats
		const qdrantStats = await qdrantService.getStats();

		// Count by memory type (scoped to workspace if provided)
		const typeFilter = input.workspace !== undefined ? { workspace: input.workspace } : {};

		// Parallelize count operations (workspace count + type counts)
		const [workspaceCount, episodic, shortTerm, longTerm] = await Promise.all([
			input.workspace !== undefined ? qdrantService.count({ workspace: input.workspace }) : Promise.resolve(undefined),
			qdrantService.count({ memory_type: 'episodic', ...typeFilter }),
			qdrantService.count({ memory_type: 'short-term', ...typeFilter }),
			qdrantService.count({ memory_type: 'long-term', ...typeFilter }),
		]);

		const typeCounts = {
			episodic,
			short_term: shortTerm,
			long_term: longTerm,
		};

		// Get embedding stats if requested
		let embeddingStats;
		if (input.include_embedding_stats) {
			embeddingStats = embeddingService.getStats();
		}

		logger.info('Memory status retrieved');

		return successResponse(
			'Server is healthy',
			{
				server: 'mcp-memory',
				timestamp: new Date().toISOString(),
				collection: {
					points_count: qdrantStats.points_count,
					indexed_vectors_count: qdrantStats.indexed_vectors_count,
					segments_count: qdrantStats.segments_count,
					status: qdrantStats.status,
					optimizer_status: qdrantStats.optimizer_status,
					access_tracking_failures: qdrantStats.access_tracking_failures,
				},
				workspace: input.workspace
					? {
						name: input.workspace,
						count: workspaceCount,
					}
					: undefined,
				by_type: typeCounts,
				embeddings: embeddingStats,
			},
			{
				duration_ms: Date.now() - startTime,
			},
		);
	} catch (error: unknown) {
		logger.error('Failed to get memory status:', error);
		if (error instanceof z.ZodError) {
			return validationError('Invalid input parameters', error.issues);
		}
		return errorResponse('Failed to get memory status', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Handles the memory-count MCP tool — counts memories matching optional filter criteria.
 *
 * Returns the total count of memories in the collection, optionally filtered by workspace,
 * memory_type, confidence threshold, or tags. Useful for checking capacity without loading records.
 *
 * @param args - Validated MemoryCountInput with optional filter (workspace, memory_type, min_confidence, tags).
 * @returns Promise resolving to StandardResponse with count and filter summary.
 * @throws Never throws; returns errorResponse() on invalid input or query failure.
 * @example
 * ```typescript
 * const result = await memoryCountHandler({ filter: { memory_type: 'long-term', workspace: 'default' } });
 * // Returns: { success: true, data: { count: 42, filter: {...} } }
 * ```
 */
async function memoryCountHandler(args: unknown): Promise<StandardResponse> {
	const startTime = Date.now();

	try {
		const input = MemoryCountInputSchema.parse(args);
		logger.info('Counting memories...');

		const count = await qdrantService.count(input.filter);

		logger.info(`Counted ${count} memories`);

		return successResponse(
			`Counted ${count} memories`,
			{
				count,
				filter: input.filter,
			},
			{
				duration_ms: Date.now() - startTime,
			},
		);
	} catch (error: unknown) {
		logger.error('Failed to count memories:', error);
		if (error instanceof z.ZodError) {
			return validationError('Invalid input parameters', error.issues);
		}
		return errorResponse('Failed to count memories', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Array of all available MCP memory tools for tool registration.
 *
 * Includes 9 tools covering the full memory lifecycle: store, query, list, get,
 * update, delete, batch-delete, status, and count operations.
 *
 * @example
 * ```typescript
 * // All tools are registered by the MCP server at startup
 * memoryTools.forEach(tool => {
 *   console.log(tool.name); // 'memory-store', 'memory-query', etc.
 * });
 * ```
 */
export const memoryTools: MCPTool[] = [
	{
		name: 'memory-store',
		description:
      'Store information in semantic memory with automatic classification and metadata enrichment',
		inputSchema: memorySchemas['memory-store'],
		handler: memoryStoreHandler,
	},
	{
		name: 'memory-query',
		description:
      'Search for similar memories using semantic search with optional filtering by workspace, type, and other metadata',
		inputSchema: memorySchemas['memory-query'],
		handler: memoryQueryHandler,
	},
	{
		name: 'memory-list',
		description:
      'List memories with pagination and filtering. Use for browsing or bulk operations',
		inputSchema: memorySchemas['memory-list'],
		handler: memoryListHandler,
	},
	{
		name: 'memory-get',
		description: 'Retrieve a specific memory by its ID',
		inputSchema: memorySchemas['memory-get'],
		handler: memoryGetHandler,
	},
	{
		name: 'memory-update',
		description:
      'Update memory content or metadata. Content updates automatically trigger reindexing with new embeddings',
		inputSchema: memorySchemas['memory-update'],
		handler: memoryUpdateHandler,
	},
	{
		name: 'memory-delete',
		description: 'Delete a specific memory by its ID',
		inputSchema: memorySchemas['memory-delete'],
		handler: memoryDeleteHandler,
	},
	{
		name: 'memory-batch-delete',
		description: 'Delete multiple memories by their IDs in a single operation. Returns the count of delete operations issued (not confirmed deletions).',
		inputSchema: memorySchemas['memory-batch-delete'],
		handler: memoryBatchDeleteHandler,
	},
	{
		name: 'memory-status',
		description:
      'Health check and statistics: server status, collection counts by type, workspace stats, and embedding usage',
		inputSchema: memorySchemas['memory-status'],
		handler: memoryStatusHandler,
	},
	{
		name: 'memory-count',
		description: 'Count memories matching specific filter criteria',
		inputSchema: memorySchemas['memory-count'],
		handler: memoryCountHandler,
	},
];
