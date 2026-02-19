# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`mcp-memory` is a Model Context Protocol (MCP) server providing semantic memory and knowledge management for Claude Code. It uses OpenAI embeddings (or local HuggingFace/ONNX) + Qdrant vector database to store, search, and manage memories with automatic classification, secrets detection, and workspace isolation.

## Commands

```bash
yarn build            # Compile TypeScript → ./build/
yarn dev              # Build and run (tsc && node build/index.js)
yarn watch            # TypeScript watch mode
yarn typecheck        # Type check without emitting
yarn lint             # ESLint src/
yarn lint:fix         # ESLint with auto-fix
yarn test             # Run Vitest tests
yarn test:coverage    # Run tests with coverage report (70% threshold enforced)
yarn start            # Run built server
```

To run a single test file: `yarn vitest run src/utils/__tests__/retry.test.ts`

`yarn test:ui` opens the interactive Vitest UI in a browser.

## Architecture

The server uses stdio transport (MCP protocol). Requests flow:

```
MCP Client → MCP Server (src/index.ts)
           → Tool Handlers (src/tools/)
           → Services (src/services/)
           → External: OpenAI API + Qdrant DB
```

**Entry point** (`src/index.ts`): Initializes MCP server, registers tool handlers, starts RulesManager to copy `rules/` → `.claude/rules/` on startup. When `EMBEDDING_PROVIDER=local`, preloads the HuggingFace model in the background.

**Configuration** (`src/config.ts`): All env vars loaded and validated via Zod. See `.env.example` for all variables — `QDRANT_URL` is the only required one. The `embedding.provider` field is auto-detected: `'openai'` if `OPENAI_API_KEY` is present, `'local'` otherwise.

**Types** (`src/types/index.ts`): Shared interfaces — `MemoryType`, `MemoryMetadata`, `SearchResult`, `StandardResponse<T>`, `ErrorType`, `MCPTool`, `EmbeddingStats`, `QdrantPayload`, `SearchFilters`.

**Tools** (`src/tools/memory-tools.ts`): 9 tools — `memory-store`, `memory-query`, `memory-list`, `memory-get`, `memory-update`, `memory-delete`, `memory-batch-delete`, `memory-status`, `memory-count`. Tool inputs are validated via Zod schemas in `src/schemas/memory-schemas.ts` which also generate JSON Schema for MCP registration.

**Services** (each is a singleton exported from its module):
- `QdrantService` — vector DB operations; stores two named vectors per point: `dense` (small) and `dense_large`. Supports dense HNSW + sparse BM25 hybrid search with Reciprocal Rank Fusion.
- `EmbeddingService` — OpenAI embeddings (text-embedding-3-small / text-embedding-3-large) or local HuggingFace model, with 10,000-entry LRU cache and cost tracking.
- `LocalEmbeddingProvider` — HuggingFace/ONNX CPU inference (default: `Xenova/all-MiniLM-L6-v2`, 384d). Model cached at `~/.cache/mcp-memory/models`; first call downloads ~20–140 MB.
- `SecretsDetector` — blocks storage of 18+ secret patterns. High-confidence matches block immediately; 5+ distinct medium-confidence matches also block.
- `WorkspaceDetector` — derives workspace name from env var → package.json → directory name. Reserved names (`system`, `admin`, `root`, etc.) are rejected.
- `RulesManager` — copies `rules/*.md` into `.claude/rules/` at startup.

## Key Patterns

**Adding a new tool**: Define Zod schema in `src/schemas/memory-schemas.ts`, add handler in `src/tools/memory-tools.ts`, register in `src/tools/index.ts`.

**Error handling**: Use `successResponse()` / `errorResponse()` from `src/utils/response.ts` for all tool return values — they produce the `StandardResponse` type expected by the MCP client. `validationError()` and `notFoundError()` are convenience shorthands.

**Chunking**: Content longer than 1,000 chars is auto-split into overlapping chunks. All chunks share a `chunk_group_id` UUID stored in metadata. `memory-update` blocks updates to individual chunks (must update via the group).

**Retry logic**: `src/utils/retry.ts` provides exponential backoff; used by both `QdrantService` and `EmbeddingService` for external API calls.

**Logging**: `src/utils/logger.ts` exports a singleton `logger` with `debug/info/warn/error` methods. Log level controlled by `LOG_LEVEL` env var.

## TypeScript Configuration

Requires Node.js >= 24. Outputs to `./build/`, targets ES2022, module resolution `bundler`. Tests use Vitest (config in `vitest.config.ts`); coverage threshold is 70% across lines, functions, branches, and statements.

## CI/CD

Single workflow (`.github/workflows/ci.yml`) triggered on push to `main`, PRs to `main`, and `v*` tags:
- **Push to `main` / PR**: typecheck → lint → test → build
- **Push `v*` tag**: typecheck → lint → test → build + publish to GitHub Packages + create GitHub Release

## Rules

`rules/memory.md` (736 lines) is the canonical documentation for memory system usage patterns and is automatically copied to `.claude/rules/memory.md` when the server starts. Edit this file when memory usage guidance needs updating.
