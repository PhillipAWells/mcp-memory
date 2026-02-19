/**
 * Shared type definitions
 *
 * Core domain types used across tool handlers, services, and schemas.
 * Import from this module rather than defining types locally so the entire
 * codebase stays in sync.
 */

/**
 * Memory classification type controlling retention policy and search behaviour.
 * - `episodic`   — specific experiences or events; auto-expires after 90 days.
 * - `short-term` — volatile working context; auto-expires after 7 days.
 * - `long-term`  — persistent facts, concepts, and workflows; no expiry.
 */
export type MemoryType =
  | 'episodic'      // Specific experiences, events
  | 'short-term'    // Volatile working memory
  | 'long-term';    // Persistent knowledge (facts, concepts, workflows)

/**
 * Metadata that can be attached to a stored memory.
 *
 * All fields are optional.  The index signature (`[key: string]: any`) allows
 * callers to persist custom fields that are forwarded verbatim to Qdrant.
 */
export interface MemoryMetadata {
  /** Classification controlling retention and search prioritisation. */
  memory_type?: MemoryType;

  /** Workspace slug for multi-project isolation. */
  workspace?: string | null;

  /** Reliability score in [0, 1].  Higher values surface results earlier. */
  confidence?: number;
  /** ISO 8601 expiry datetime.  The point is excluded from queries after this time. */
  expiresAt?: string;

  /** Running total of times this memory has been retrieved. */
  accessCount?: number;
  /** ISO 8601 timestamp of the most recent retrieval. */
  lastAccessedAt?: string;

  /** ISO 8601 creation timestamp. */
  createdAt?: string;
  /** ISO 8601 last-modified timestamp. */
  updatedAt?: string;

  /** Searchable labels for categorisation. */
  tags?: string[];
  /** Alternative names or identifiers for this memory. */
  aliases?: string[];

  /** Custom caller-defined fields, passed through to Qdrant unchanged. */
  [key: string]: any;
}

/**
 * A single result returned by a vector search or point retrieval operation.
 */
export interface SearchResult {
  /** UUID of the Qdrant point. */
  id: string;
  /** Optional file-system path associated with the memory (may be empty). */
  path: string;
  /** The stored text content. */
  content: string;
  /** Cosine similarity score in [0, 1]; 1.0 for exact retrievals via `get()`. */
  score: number;
  /** Full Qdrant payload as stored in the vector database (snake_case field names). */
  metadata: QdrantPayload;
}

/**
 * Envelope returned by every MCP tool handler.
 *
 * The MCP client receives this object serialised as JSON.  On `success: true`,
 * `data` holds the operation result.  On `success: false`, `error` and
 * `error_type` describe the failure.
 *
 * @template T - Type of the `data` payload on success.
 */
export interface StandardResponse<T = any> {
  /** `true` on success, `false` on any error. */
  success: boolean;
  /** Human-readable summary of the outcome. */
  message: string;
  /** Operation result; present only when `success` is `true`. */
  data?: T;
  /** Arbitrary key/value bag for supplementary information (e.g. timing). */
  metadata?: Record<string, any>;
  /** Detailed error message; present only when `success` is `false`. */
  error?: string;
  /** Categorical error type for programmatic handling. */
  error_type?: ErrorType;
  /** Wall-clock duration of the operation. */
  timing?: {
    /** Elapsed milliseconds. */
    duration_ms: number;
    /** Elapsed seconds (convenience; equals `duration_ms / 1000`). */
    duration_seconds: number;
  };
}

/**
 * Categorical error types returned in {@link StandardResponse.error_type}.
 *
 * Handlers should pick the most specific type so callers can branch
 * on error category without parsing the `message` string.
 */
export type ErrorType =
  | 'VALIDATION_ERROR'      // Input failed schema validation
  | 'CONNECTION_ERROR'      // Could not reach an external service
  | 'TIMEOUT_ERROR'         // Operation exceeded its time limit
  | 'SERVER_ERROR'          // Internal server-side failure
  | 'CLIENT_ERROR'          // Bad request from the caller
  | 'NOT_FOUND_ERROR'       // Requested resource does not exist
  | 'AUTHENTICATION_ERROR'  // Missing or invalid credentials
  | 'EXECUTION_ERROR'       // General runtime error during tool execution
  | 'UNKNOWN_ERROR';        // Uncategorised failure

/**
 * MCP tool definition registered with the MCP server.
 *
 * The server iterates over the {@link tools} array, registers each tool's
 * `name` + `inputSchema` with the MCP protocol layer, and routes incoming
 * `tools/call` requests to the matching `handler`.
 */
export interface MCPTool {
  /** Unique tool identifier used in MCP `tools/call` requests. */
  name: string;
  /** Human-readable description shown in tool listings. */
  description: string;
  /**
   * JSON Schema descriptor used by the MCP layer to validate incoming arguments.
   * Typed permissively to accept the output of `zod-to-json-schema` without casts.
   * `type` is `string | string[]` because JSON Schema allows both forms
   * (e.g. `"object"` or `["string", "number"]`).
   */
  inputSchema: {
    type?: string | string[];
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  /**
   * Async function that implements the tool.
   * Receives the validated (but untyped) `args` object and must return
   * a {@link StandardResponse}.
   */
  handler: (args: any) => Promise<StandardResponse>;
}

/**
 * Cumulative statistics for the {@link EmbeddingService}.
 * Returned by `embeddingService.getStats()` and included in `memory-status` responses.
 */
export interface EmbeddingStats {
  /** Total number of `generateEmbedding` / `generateLargeEmbedding` calls. */
  totalEmbeddings: number;
  /** Number of calls served from the LRU cache. */
  cacheHits: number;
  /** Number of calls that required a new API call or local inference. */
  cacheMisses: number;
  /** Total OpenAI tokens consumed (0 for local provider). */
  totalTokens: number;
  /** Estimated USD cost based on OpenAI pricing (0 for local provider). */
  totalCost: number;
  /** `cacheHits / totalEmbeddings`; in [0, 1]. */
  cacheHitRate: number;
}

/**
 * Shape of the payload stored alongside each Qdrant vector point.
 *
 * All fields except `content`, `created_at`, and `updated_at` are optional.
 * The index signature allows arbitrary caller-defined fields to be stored and
 * retrieved without schema changes.
 */
export interface QdrantPayload {
  /** Point UUID; set by the application, not by Qdrant. */
  id?: string;
  /** The raw text that was embedded and stored. */
  content: string;
  /** Optional file-system path associated with this memory. */
  path?: string;
  /** Workspace slug for multi-project isolation; `null` for unscoped memories. */
  workspace?: string | null;
  /** Zero-based index of this chunk within a chunked document. */
  chunk_index?: number;
  /** Total number of chunks that make up the original document. */
  total_chunks?: number;
  /** UUID shared by all chunks that belong to the same document. */
  chunk_group_id?: string;
  /** Memory classification type. */
  memory_type?: MemoryType;
  /** Reliability score in [0, 1]. */
  confidence?: number;
  /** Searchable labels. */
  tags?: string[];
  /** ISO 8601 expiry datetime; `null` means the memory never expires. */
  expires_at?: string | null;
  /** ISO 8601 creation timestamp. */
  created_at: string;
  /** ISO 8601 last-modified timestamp. */
  updated_at: string;
  /** Number of times this point has been returned by a query or retrieval. */
  access_count?: number;
  /** ISO 8601 timestamp of the most recent access; `null` if never accessed. */
  last_accessed_at?: string | null;
  /** Arbitrary caller-defined fields. */
  [key: string]: any;
}

/**
 * Filter parameters accepted by {@link QdrantService.search},
 * {@link QdrantService.list}, and {@link QdrantService.count}.
 *
 * All fields are optional.  Only memories that match every specified field
 * are returned (implicit AND).  Expired memories are always excluded.
 */
export interface SearchFilters {
  /** Restrict to a specific workspace slug; `null` matches unscoped memories. */
  workspace?: string | null;
  /** Restrict to a specific memory type. */
  memory_type?: MemoryType;
  /** Minimum `confidence` value (inclusive). */
  minConfidence?: number;
  /** Restrict to memories that have at least one of these tags. */
  tags?: string[];
  /** Match on arbitrary payload fields (exact value match per key). */
  metadata?: Record<string, any>;
}
