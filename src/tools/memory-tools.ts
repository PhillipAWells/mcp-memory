/**
 * Memory MCP Tools
 *
 * Core memory operations: store, query, list, get, update, delete
 */

import { v4 as uuidv4 } from 'uuid';

/** Expiry in days for episodic memories. */
const EPISODIC_EXPIRY_DAYS = 90;
/** Expiry in days for short-term memories. */
const SHORT_TERM_EXPIRY_DAYS = 7;
/** Character limit for content preview in list responses. */
const CONTENT_PREVIEW_LENGTH = 200;
/** Character threshold above which content is chunked. */
const CHUNK_THRESHOLD_LENGTH = 1000;
/** Max characters of query shown in debug logs. */
const QUERY_LOG_LENGTH = 50;
/** Max records to sort in memory (beyond this, warn and cap). */
const MAX_IN_MEMORY_SORT_COUNT = 10000;
import { MCPTool, StandardResponse, SearchResult } from '../types/index.js';
import { successResponse, errorResponse, validationError, notFoundError } from '../utils/response.js';
import { extractErrorMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { qdrantService } from '../services/qdrant-client.js';
import { embeddingService } from '../services/embedding-service.js';
import { workspaceDetector } from '../services/workspace-detector.js';
import { isSafeToStore, getSecretsSummary, detectSecrets } from '../services/secrets-detector.js';
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

/**
 * Memory Store Tool
 */
async function memoryStoreHandler(args: any): Promise<StandardResponse> {
	const startTime = Date.now();

	try {
		const input = MemoryStoreInputSchema.parse(args);
		logger.info('Storing memory...');

		// Check for secrets and sensitive information
		const safetyCheck = isSafeToStore(input.content);
		if (!safetyCheck.safe) {
			logger.warn(`Blocked memory storage: ${safetyCheck.reason}`);

			const detection = detectSecrets(input.content);
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
					error_code: 'SECRETS_DETECTED',
					secrets_detected: secretsList,
					summary: getSecretsSummary(detection),
					suggestion: 'Remove sensitive data before storing. Use placeholders like [API_KEY] or [PASSWORD] instead.',
					sanitized_preview: detection.sanitized?.slice(0, CONTENT_PREVIEW_LENGTH) + '...',
				},
			);
		}

		// Warn if low/medium confidence secrets detected
		if (safetyCheck.reason && safetyCheck.secrets) {
			logger.warn(`Storing with warning: ${safetyCheck.reason}`);
		}

		const metadata = input.metadata ?? {};

		// Auto-set expires_at based on memory type (if not already provided)
		if (metadata.expires_at === undefined) {
			const memoryType = metadata.memory_type;
			if (memoryType === 'episodic') {
				const expiry = new Date();
				expiry.setDate(expiry.getDate() + EPISODIC_EXPIRY_DAYS);
				metadata.expires_at = expiry.toISOString();
			} else if (memoryType === 'short-term') {
				const expiry = new Date();
				expiry.setDate(expiry.getDate() + SHORT_TERM_EXPIRY_DAYS);
				metadata.expires_at = expiry.toISOString();
			}
		}

		// Detect workspace if not provided
		if (metadata.workspace === undefined) {
			const detected = workspaceDetector.detect();
			metadata.workspace = detected.workspace;
			logger.debug(`Detected workspace: ${metadata.workspace ?? 'none'}`);
		}

		// Normalize workspace to lowercase for consistent storage
		if (metadata.workspace !== null && metadata.workspace !== undefined) {
			metadata.workspace = workspaceDetector.normalize(metadata.workspace);
		}

		// Handle chunking for long content
		if (input.auto_chunk && input.content.length > CHUNK_THRESHOLD_LENGTH) {
			const chunked = await embeddingService.generateChunkedEmbeddings(input.content);

			// All chunks share a common group ID so siblings can be found and managed together
			const chunkGroupId = uuidv4();

			const ids: string[] = [];
			for (const { chunk, embedding, index, total } of chunked) {
				const largeEmbedding = await embeddingService.generateLargeEmbedding(chunk);
				const id = await qdrantService.upsert(
					chunk,
					embedding,
					{ ...metadata, chunk_index: index, total_chunks: total, chunk_group_id: chunkGroupId },
					largeEmbedding,
				);
				ids.push(id);
			}

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
		if (error instanceof Error && error.name === 'ZodError') {
			return validationError('Invalid input parameters', (error as any).errors);
		}
		return errorResponse('Failed to store memory', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Memory Query Tool
 */
async function memoryQueryHandler(args: any): Promise<StandardResponse> {
	const startTime = Date.now();

	try {
		const input = MemoryQueryInputSchema.parse(args);
		logger.info(`Querying memory: "${input.query.slice(0, QUERY_LOG_LENGTH)}..."`);

		const dual = await embeddingService.generateDualEmbeddings(input.query);

		// Search Qdrant (with optional hybrid search using RRF)
		const results = await qdrantService.search({
			vector: dual.small,
			vectorLarge: dual.large,
			filter: input.filter,
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
		if (error instanceof Error && error.name === 'ZodError') {
			return validationError('Invalid input parameters', (error as any).errors);
		}
		return errorResponse('Failed to query memory', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Memory List Tool
 */
async function memoryListHandler(args: any): Promise<StandardResponse> {
	const startTime = Date.now();

	try {
		const input = MemoryListInputSchema.parse(args);
		logger.info('Listing memories...');

		// Warn if sorting large result sets
		if (input.sort_by && input.sort_by !== 'created_at') {
			const estimatedCount = await qdrantService.count(input.filter);
			if (estimatedCount > MAX_IN_MEMORY_SORT_COUNT) {
				logger.warn(
					`Sorting ${estimatedCount} records in memory may be slow. ` +
          'Consider using filters to reduce result set size.',
				);
			}
		}

		// Determine fetch strategy based on sorting needs
		let results: SearchResult[];

		if (!input.sort_by || input.sort_by === 'created_at') {
			// Qdrant scroll returns results roughly in creation order
			// Fetch only what we need with pagination
			results = await qdrantService.list(
				input.filter,
				input.limit,
				input.offset,
			);

			// Apply sort order if specified
			if (input.sort_order === 'asc') {
				results.sort((a, b) => {
					const aTime = new Date(a.metadata?.created_at ?? 0).getTime();
					const bTime = new Date(b.metadata?.created_at ?? 0).getTime();
					return aTime - bTime;
				});
			}
			// Default DESC order from Qdrant is already correct
		} else {
			// For other sort fields, we must fetch all matching records and sort in memory.
			// Fetching only limit+offset would produce incorrect results because Qdrant's
			// scroll order is internal — not the requested sort order.
			const totalCount = await qdrantService.count(input.filter);
			const fetchLimit = Math.min(totalCount, MAX_IN_MEMORY_SORT_COUNT);
			if (totalCount > MAX_IN_MEMORY_SORT_COUNT) {
				logger.warn(
					`Sorting ${totalCount} records: only the first ${MAX_IN_MEMORY_SORT_COUNT} are loaded for performance. ` +
          'Results beyond this cap may be missing. Use filters to narrow the result set.',
				);
			}
			const allResults = await qdrantService.list(
				input.filter,
				fetchLimit,
				0,
			);

			// Sort by requested field
			const sortedResults = allResults.sort((a, b) => {
				let aValue: any;
				let bValue: any;

				switch (input.sort_by) {
					case 'updated_at':
						aValue = new Date(a.metadata?.updated_at ?? 0).getTime();
						bValue = new Date(b.metadata?.updated_at ?? 0).getTime();
						break;
					case 'access_count':
						aValue = a.metadata?.access_count ?? 0;
						bValue = b.metadata?.access_count ?? 0;
						break;
					case 'confidence':
						aValue = a.metadata?.confidence ?? 0;
						bValue = b.metadata?.confidence ?? 0;
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

		return successResponse(
			`Listed ${results.length} memories`,
			{
				memories: results.map((r) => ({
					id: r.id,
					content: r.content.slice(0, CONTENT_PREVIEW_LENGTH), // Truncate for listing
					metadata: r.metadata,
				})),
				count: results.length,
				limit: input.limit,
				offset: input.offset,
			},
			{
				duration_ms: Date.now() - startTime,
			},
		);
	} catch (error: unknown) {
		logger.error('Failed to list memories:', error);
		if (error instanceof Error && error.name === 'ZodError') {
			return validationError('Invalid input parameters', (error as any).errors);
		}
		return errorResponse('Failed to list memories', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Memory Get Tool
 */
async function memoryGetHandler(args: any): Promise<StandardResponse> {
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
		if (error instanceof Error && error.name === 'ZodError') {
			return validationError('Invalid input parameters', (error as any).errors);
		}
		return errorResponse('Failed to get memory', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Memory Update Tool
 */
async function memoryUpdateHandler(args: any): Promise<StandardResponse> {
	const startTime = Date.now();

	try {
		const input = MemoryUpdateInputSchema.parse(args);
		logger.info(`Updating memory: ${input.id}`);

		// Check for secrets if content is being updated
		if (input.content) {
			const safetyCheck = isSafeToStore(input.content);
			if (!safetyCheck.safe) {
				logger.warn(`Blocked memory update: ${safetyCheck.reason}`);

				const detection = detectSecrets(input.content);
				const secretsList = safetyCheck.secrets?.map(s => ({
					type: s.type,
					pattern: s.pattern,
					confidence: s.confidence,
					context: s.context,
				})) ?? [];

				return errorResponse(
					'Cannot update content with sensitive information',
					'VALIDATION_ERROR',
					safetyCheck.reason,
					{
						id: input.id,
						error_code: 'SECRETS_DETECTED',
						secrets_detected: secretsList,
						summary: getSecretsSummary(detection),
						suggestion: 'Remove sensitive data before updating. Use placeholders like [API_KEY] or [PASSWORD] instead.',
					},
				);
			}

			// Warn if low/medium confidence secrets detected
			if (safetyCheck.reason && safetyCheck.secrets) {
				logger.warn(`Updating with warning: ${safetyCheck.reason}`);
			}
		}

		// Get existing memory
		const existing = await qdrantService.get(input.id);
		if (!existing) {
			return notFoundError(`Memory with ID ${input.id}`);
		}

		// Guard against updating individual chunks of a chunked memory.
		// Updating one chunk would leave its siblings stale with no way to sync them.
		if (existing.metadata?.chunk_index !== undefined) {
			const chunkGroupId = existing.metadata?.chunk_group_id;
			return errorResponse(
				'Cannot update an individual chunk of a chunked memory',
				'VALIDATION_ERROR',
				'Updating one chunk would leave its siblings out of sync.',
				{
					id: input.id,
					chunk_index: existing.metadata.chunk_index,
					total_chunks: existing.metadata.total_chunks,
					chunk_group_id: chunkGroupId,
					suggestion: chunkGroupId
						? `Delete all chunks sharing chunk_group_id "${chunkGroupId}" ` +
              '(use memory-query or memory-list with metadata filter), then re-store the updated content.'
						: 'Delete this chunk and its siblings, then re-store the updated content.',
				},
			);
		}

		// If content is being updated and reindex is requested
		if (input.content && input.reindex) {
			logger.debug('Re-generating dual embeddings for updated content');
			const dual = await embeddingService.generateDualEmbeddings(input.content);

			const mergedMetadata = {
				...existing.metadata,
				...input.metadata,
				// Preserve the original ID so the upsert overwrites the existing point atomically.
				// This is safe because Qdrant's upsert is idempotent — no delete needed.
				id: input.id,
			};

			await qdrantService.upsert(
				input.content,
				dual.small,
				mergedMetadata,
				dual.large,
			);

			logger.info(`Memory updated and reindexed: ${input.id}`);
		} else {
			// Just update metadata
			await qdrantService.updatePayload(input.id, input.metadata ?? {});
			logger.info(`Memory metadata updated: ${input.id}`);
		}

		return successResponse(
			'Memory updated successfully',
			{
				id: input.id,
				reindexed: input.reindex && !!input.content,
			},
			{
				duration_ms: Date.now() - startTime,
			},
		);
	} catch (error: unknown) {
		logger.error('Failed to update memory:', error);
		if (error instanceof Error && error.name === 'ZodError') {
			return validationError('Invalid input parameters', (error as any).errors);
		}
		return errorResponse('Failed to update memory', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Memory Delete Tool
 */
async function memoryDeleteHandler(args: any): Promise<StandardResponse> {
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
		if (error instanceof Error && error.name === 'ZodError') {
			return validationError('Invalid input parameters', (error as any).errors);
		}
		return errorResponse('Failed to delete memory', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Memory Batch Delete Tool
 */
async function memoryBatchDeleteHandler(args: any): Promise<StandardResponse> {
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
		if (error instanceof Error && error.name === 'ZodError') {
			return validationError('Invalid input parameters', (error as any).errors);
		}
		return errorResponse('Failed to batch delete memories', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Memory Status Tool (combines server health + collection statistics)
 */
async function memoryStatusHandler(args: any): Promise<StandardResponse> {
	const startTime = Date.now();

	try {
		const input = MemoryStatusInputSchema.parse(args);
		logger.info('Getting memory status...');

		// Get Qdrant stats
		const qdrantStats = await qdrantService.getStats();

		// Count by workspace if specified
		let workspaceCount: number | undefined;
		if (input.workspace !== undefined) {
			workspaceCount = await qdrantService.count({
				workspace: input.workspace,
			});
		}

		// Count by memory type
		const typeCounts = {
			episodic: await qdrantService.count({ memory_type: 'episodic' }),
			short_term: await qdrantService.count({ memory_type: 'short-term' }),
			long_term: await qdrantService.count({ memory_type: 'long-term' }),
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
		if (error instanceof Error && error.name === 'ZodError') {
			return validationError('Invalid input parameters', (error as any).errors);
		}
		return errorResponse('Failed to get memory status', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Memory Count Tool
 */
async function memoryCountHandler(args: any): Promise<StandardResponse> {
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
		if (error instanceof Error && error.name === 'ZodError') {
			return validationError('Invalid input parameters', (error as any).errors);
		}
		return errorResponse('Failed to count memories', 'EXECUTION_ERROR', extractErrorMessage(error));
	}
}

/**
 * Export all memory tools
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
      'Update memory content or metadata. Can optionally reindex content with new embeddings',
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
		description: 'Delete multiple memories by their IDs in a single operation',
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
