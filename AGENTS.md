## Project Overview

`@pawells/mcp-memory` is a Model Context Protocol (MCP) server providing semantic memory and knowledge management for Claude Code and other MCP clients. It uses OpenAI embeddings combined with Qdrant vector database to store, search, and manage memories. Features include automatic memory classification (short-term/episodic/long-term), secrets detection, workspace isolation, hybrid search (dense vector + keyword full-text, fused via RRF), and LRU caching for cost optimization. Published to npm.

## Package Manager

Project uses **Yarn Berry** (`yarn@4.12.0`) managed via corepack. Before working:

```bash
corepack enable       # Enable corepack to use the pinned yarn version
```

Configuration is in `.yarnrc.yml`. All dependencies are managed through Yarn:

```bash
yarn install          # Install dependencies with lockfile validation
yarn add <package>    # Add a package
yarn remove <package> # Remove a package
```

## Commands

```bash
yarn build            # Compile TypeScript (tsc) → ./build/
yarn dev              # Build and run (tsc && node build/index.js)
yarn watch            # TypeScript watch mode
yarn typecheck        # Type check without emitting
yarn lint             # ESLint src/
yarn lint:fix         # ESLint with auto-fix
yarn test             # Run Vitest tests
yarn test:ui          # Open interactive Vitest UI in a browser
yarn test:coverage    # Run tests with coverage report (80% threshold)
yarn start            # Run the MCP server
```

To run a single test file: `yarn vitest run src/path/to/file.spec.ts`

## Architecture

The server communicates via stdio transport (MCP protocol). Requests flow through:

```
MCP Client (Claude Code) → MCP Server (src/index.ts)
                         → Tool Handlers (src/tools/)
                         → Services (src/services/)
                         → External: OpenAI API + Qdrant DB
```

**Entry point** (`src/index.ts`): Initializes the MCP server, registers 9 tool handlers, and starts RulesManager to copy `rules/` into `.claude/rules/` on startup. `src/utils/proxy.ts` is imported first to ensure the global fetch dispatcher is configured before any HTTP client is constructed.

**Configuration** (`src/config.ts`): All environment variables are loaded and validated using Zod schemas. See `.env.example` for complete variable list. `OPENAI_API_KEY` and `QDRANT_URL` are required.

**Types** (`src/types/index.ts`): Shared interfaces including `MemoryType`, `SearchResult`, `StandardResponse<T>`, `ErrorType`, `MCPTool`, `EmbeddingStats`, `QdrantPayload`, and `SearchFilters`.

**Schemas** (`src/schemas/memory-schemas.ts`): Zod schemas for all tool inputs, automatically generating JSON Schema for MCP registration. Validates `memory-store`, `memory-query`, `memory-list`, `memory-get`, `memory-update`, `memory-delete`, `memory-batch-delete`, `memory-status`, and `memory-count` inputs.

**Tools** (`src/tools/memory-tools.ts`): Implements 9 MCP tools for memory management. Each tool is registered with input schemas and returns `StandardResponse<T>` for MCP protocol compliance.

**Services** (singleton exports from `src/services/`):
- `QdrantService` — Vector database operations; stores two named vectors per point (`dense` for small embeddings, `dense_large` for large). Combines dense HNSW vector similarity search with Qdrant keyword full-text index search, fused via manual Reciprocal Rank Fusion (RRF).

  > **Note:** The text index uses Qdrant's keyword tokenizer for word-level full-text matching, not statistical BM25 scoring.
- `EmbeddingService` — OpenAI embeddings (text-embedding-3-small/large) with 10,000-entry LRU cache and cost tracking.
- `SecretsDetector` — Blocks storage of 18+ secret patterns (API keys, tokens, passwords, etc.). High-confidence matches block immediately; 3+ distinct medium-confidence matches also block.
- `WorkspaceDetector` — Derives workspace name from env var → package.json → directory name. Reserved names (`system`, `admin`, `root`, etc.) are rejected.
- `RulesManager` — Copies `rules/*.md` into `.claude/rules/` at startup.

**Utilities** (`src/utils/`):
- `response.ts` — `successResponse()`, `errorResponse()`, `validationError()`, `notFoundError()` helpers for MCP protocol compliance.
- `logger.ts` — Singleton logger with `debug/info/warn/error` methods; level controlled by `LOG_LEVEL` env var.
- `retry.ts` — Exponential backoff retry logic for external API calls.
- `proxy.ts` — Proxy initialisation; reads `HTTPS_PROXY`/`HTTP_PROXY` env vars and installs a global undici `EnvHttpProxyAgent` dispatcher at import time. Auto-defaults `NO_PROXY` to `localhost,127.0.0.1,::1` when a proxy is active and no exclusions are set. Must be the first import in `src/index.ts`.
- `errors.ts` — Custom error types.

## Key Concepts

**Memory Classification**: The server classifies memories into three retention tiers:
- `short-term` — Volatile working context and in-progress state, auto-expires after 7 days
- `episodic` — Session-specific experiences, auto-expires after 90 days
- `long-term` — Permanent storage for facts, decisions, workflows, and established patterns

Expired memories are automatically filtered from queries and listings.

**Dual Embeddings**: By default, all content is embedded twice — once with `text-embedding-3-small` (384 dimensions) for cost efficiency, and once with `text-embedding-3-large` (3072 dimensions) for accuracy. Queries can use either vector for flexible quality-vs-cost tradeoffs.

**Hybrid Search (RRF)**: Text queries with `use_hybrid_search=true` combine dense vector similarity with full-text index search. Results are fused using Reciprocal Rank Fusion (RRF) with configurable weighting (default 50/50). Note: hybrid search does not support pagination.

**Chunking**: Content longer than 1000 chars is automatically split into overlapping chunks. All chunks in a group share a `chunk_group_id`, and updates to any chunk trigger re-chunking of the entire group.

**Workspace Isolation**: Optional workspace slug (`[a-zA-Z0-9_-]+`) isolates memories for multi-project scenarios. Auto-detected from env vars, package.json name, or directory name.

## Key Patterns

**Adding a new tool**: Define Zod schema in `src/schemas/memory-schemas.ts`, implement handler in `src/tools/memory-tools.ts`, register in `src/tools/index.ts`.

**Error handling**: Always return `successResponse()` or `errorResponse()` from tools. Use `validationError()` for schema violations and `notFoundError()` for missing memories — both produce the `StandardResponse` type expected by MCP clients.

**Chunking**: Content longer than the configured `MEMORY_CHUNK_SIZE` (default 1,000 chars) is auto-split into overlapping chunks. All chunks share a `chunk_group_id` UUID in metadata. `memory-update` blocks updates to individual chunks — must update via the group.

**Retry logic**: `src/utils/retry.ts` provides exponential backoff; used by both `QdrantService` and `EmbeddingService` for resilience against transient failures.

**Logging**: All significant operations log via `src/utils/logger.ts`. Control verbosity with `LOG_LEVEL` env var (debug/info/warn/error).

**Memory types**: Caller classifies memories into three types with different retention:
- `short-term` — 7 days (working context, in-progress state)
- `episodic` — 90 days (events, session outcomes)
- `long-term` — Permanent storage (facts, decisions, workflows)

Expired memories are automatically excluded from queries and listings.

## Public API

The MCP server exposes 9 tools to clients. All tools return `StandardResponse<T>` which includes `success`, `message`, `data`, and a `metadata` bag containing `duration_ms`.

1. **memory-store** — Embed and store a new memory.
   - Key params: `content` (required, max 100,000 chars), `metadata.memory_type`, `metadata.workspace`, `metadata.tags`, `metadata.confidence`, `auto_chunk` (default `true`).
   - Returns: `{ id, memory_type, workspace, confidence }` for single memories; `{ ids[], chunks }` for chunked content.

2. **memory-query** — Search memories by natural-language query using vector similarity.
   - Key params: `query` (required), `filter` (workspace, memory_type, min_confidence, tags), `limit` (default 10, max 100), `offset`, `score_threshold`, `use_hybrid_search`, `hybrid_alpha`, `hnsw_ef`.
   - Returns: `{ results: [{ id, content, score, metadata }], query, count }`.

3. **memory-list** — Browse memories with filtering, sorting, and pagination.
   - Key params: `filter` (workspace, memory_type, tags), `sort_by` (created_at | updated_at | access_count | confidence), `sort_order` (asc | desc), `limit` (default 100, max 1,000), `offset`.
   - Returns: `{ memories: [{ id, content (preview), metadata }], count, total_count, limit, offset }` where `count` is the page size and `total_count` is the total matching records.

4. **memory-get** — Retrieve a single memory by its UUID.
   - Key params: `id` (required UUID).
   - Returns: `{ id, content, metadata }` with full content (not truncated).

5. **memory-update** — Update content and/or metadata for an existing memory; re-embeds and re-chunks when content changes.
   - Key params: `id` (required), `content` (optional), `metadata` (optional partial), `auto_chunk` (default `true`).
   - Returns: `{ id, reindexed }` for single memories; `{ id, chunks, old_chunks, chunk_group_id }` for re-chunked content.

6. **memory-delete** — Delete a single memory by ID; returns `NOT_FOUND` if the ID does not exist.
   - Key params: `id` (required UUID).
   - Returns: `{ id }`.

7. **memory-batch-delete** — Delete up to 100 memories in a single Qdrant operation. Silently succeeds for non-existent IDs.
   - Key params: `ids` (required, 1–100 UUIDs).
   - Returns: `{ count, ids }` where `count` is the number of delete operations issued.

8. **memory-status** — Collection health, per-type counts, workspace summary, and optional embedding cost stats.
   - Key params: `workspace` (optional filter), `include_embedding_stats` (default `false`).
   - Returns: `{ server, timestamp, collection: { points_count, status, ... }, by_type: { episodic, short_term, long_term }, embeddings? }`.

9. **memory-count** — Count memories matching optional filter criteria without loading records.
   - Key params: `filter` (workspace, memory_type, min_confidence, tags) — all optional.
   - Returns: `{ count, filter }`.

See `src/tools/memory-tools.ts` for handler implementations and `src/schemas/memory-schemas.ts` for input validation.

## TypeScript Configuration

Project uses a 4-config split:

- **`tsconfig.json`** — Base/development configuration used by Vitest and editors. Includes all source files for full type checking.
- **`tsconfig.build.json`** — Production build configuration; explicitly excludes test files (`src/**/*.spec.ts`) and is used by the build script.
- **`tsconfig.test.json`** — Vitest test configuration.
- **`tsconfig.eslint.json`** — ESLint type-aware linting configuration.

Build command: `tsc` (uses `tsconfig.build.json` by default via `tsconfig.json` extends).

General configuration: Requires Node.js >= 22. Outputs to `./build/`, targets ES2022, module resolution `bundler`. Declaration files (`.d.ts`) and source maps are emitted alongside JS. Strict mode is fully enabled.

## CI/CD

Single workflow (`.github/workflows/ci.yml`) triggered on push to `main`, PRs to `main`, and `v*` tags:

- **Typecheck, lint, build**: Node pinned to 24, corepack enabled, `yarn install --immutable` for reproducible builds
- **Test**: Matrix over Node 22 and 24 to verify compatibility with both supported versions
- **Push to `main` / PR**: typecheck → lint → test → build
- **Push `v*` tag**: typecheck → lint → test → build → publish to GitHub Packages and npm (with provenance) → create GitHub Release

## Development Notes

### Configuration

All environment variables are loaded and validated at startup via `src/config.ts`. See `.env.example` for a complete template with comments.

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key for embedding generation |
| `QDRANT_URL` | Yes* | `http://localhost:6333` | Qdrant instance URL (*defaults to localhost; required for remote) |
| `QDRANT_API_KEY` | No | — | API key for authenticated Qdrant instances (min 8 chars when set) |
| `QDRANT_COLLECTION` | No | `mcp-memory` | Qdrant collection name |
| `QDRANT_TIMEOUT` | No | `30000` | Qdrant request timeout in milliseconds |
| `LOG_LEVEL` | No | `info` | Log verbosity: `debug`, `info`, `warn`, `error`, `silent` |
| `MEMORY_CHUNK_SIZE` | No | `1000` | Character threshold above which content is auto-chunked |
| `MEMORY_CHUNK_OVERLAP` | No | `200` | Character overlap between adjacent chunks (must be < `MEMORY_CHUNK_SIZE`) |
| `SMALL_EMBEDDING_DIMENSIONS` | No | `1536` | Output dimensions for `text-embedding-3-small` |
| `LARGE_EMBEDDING_DIMENSIONS` | No | `3072` | Output dimensions for `text-embedding-3-large` |
| `WORKSPACE_AUTO_DETECT` | No | `true` | Auto-detect workspace from env/package.json/directory |
| `WORKSPACE_DEFAULT` | No | — | Override workspace slug used when auto-detection yields nothing |
| `WORKSPACE_CACHE_TTL` | No | `60000` | Workspace detection cache TTL in milliseconds |
| `COPY_CLAUDE_RULES` | No | `true` | Copy `rules/*.md` into `.claude/rules/` on startup |
| `HTTPS_PROXY` / `HTTP_PROXY` | No | — | Route all outbound HTTP traffic through this proxy |
| `NO_PROXY` | No | `localhost,127.0.0.1,::1` | Comma-separated hosts excluded from proxying |

**CI note**: Only `OPENAI_API_KEY` is required in all environments. `QDRANT_URL` defaults to `http://localhost:6333`, so integration tests work without configuration when Qdrant runs locally via Docker.

**Qdrant Dependency**: Integration tests require a running Qdrant instance. Run locally via:

```bash
docker run -p 6333:6333 qdrant/qdrant
```

Or use `QDRANT_URL` env var to point to a cloud instance.

**Embedding Setup**: Set `OPENAI_API_KEY` — required for all embedding operations.

**Rules Synchronization**: By default (`COPY_CLAUDE_RULES=true`), the server copies `rules/memory.md` into `.claude/rules/memory.md` on startup. This allows Claude Code to automatically load memory usage guidance as system context.

**Development Container**: A custom `.devcontainer/Dockerfile` is provided with Node.js environment and post-creation setup hook.

**Proxy Support**: All outbound HTTP traffic (OpenAI API, Qdrant) is automatically proxied when `HTTPS_PROXY` or `HTTP_PROXY` is set. `NO_PROXY` defaults to `localhost,127.0.0.1,::1` when a proxy is active and the variable is absent, protecting local Qdrant traffic. See `src/utils/proxy.ts`.

## Testing Notes

**Coverage Threshold**: All tests must achieve 80% coverage on four metrics (lines, functions, branches, statements). Run `yarn test:coverage` to check. Coverage badges are generated in `coverage/`.

**Unit Tests**: Located in `src/**/*.spec.ts`. Test isolated functions, services, and error conditions. Use Vitest's `describe` and `it` blocks. Mocks are limited to external dependencies (OpenAI, Qdrant).

**Integration Tests**: Test end-to-end tool handlers with a live Qdrant instance. Requires `docker run -p 6333:6333 qdrant/qdrant` or `QDRANT_URL` set to a remote instance.

**Fixtures**: Test data is hardcoded or generated inline (no separate fixture files). This keeps tests self-contained and easier to understand.

**Mocking**: Use Vitest's `vi.mock()` for OpenAI client only. Real Qdrant queries are preferred in tests to catch integration bugs. If mocking Qdrant is necessary, create a minimal stub that covers only the specific method being tested.

**Common Test Patterns**:
- Tool handlers: call `parse()` on input schema first, then invoke the handler
- Services: test both happy path and error conditions (network failures, validation)
- Edge cases: empty inputs, boundary values, concurrent operations

## Common Gotchas

### Recently Stored Memories May Not Appear in Search

Queries use Qdrant's `indexed_only: true` setting to skip segments that are currently being indexed by the background HNSW indexer. For small collections or immediately after a store operation, a query issued moments later may return zero results for the memory you just stored, even though the store operation succeeded.

**Workaround**: If a query returns zero results after a recent store, wait a few seconds and retry. Qdrant typically indexes segments within seconds. The `search()` method automatically tracks access counts on hits, so indexed memories are accessed as expected.

### All Sorting Requires Loading Records Into Memory

The `memory-list` tool loads up to 10,000 records into memory for sorting regardless of the sort field chosen (`created_at`, `updated_at`, `access_count`, or `confidence`). Qdrant's internal scroll order is not guaranteed to match any application-level sort order, so the server always fetches all matching records and sorts them in-process. For collections with many memories, this can consume significant memory.

**Workaround**: Use the `workspace`, `memory_type`, or `tags` filters to narrow the result set before sorting; this reduces the number of records loaded into memory. If the built-in scroll order is acceptable for your use case, omit `sort_by` entirely — the tool will return results in Qdrant's internal order without a full fetch.

### All Sorting Uses Approximate Count for fetchLimit

The `memory-list` tool uses `qdrantService.count(exact: false)` to determine how many records to fetch before sorting. Qdrant's approximate counting is "close but not guaranteed" — for very large collections, the approximated count can be significantly lower than the actual count, potentially causing the sort to miss records beyond the approximated threshold.

**Workaround**: Use the `workspace`, `memory_type`, or `tags` filters to narrow the result set before sorting; this reduces the number of records fetched and mitigates the approximation risk. If exact count is critical, use exact: true (slower but guaranteed).
