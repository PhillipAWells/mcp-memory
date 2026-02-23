# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

`@pawells/mcp-memory` is a Model Context Protocol (MCP) server providing semantic memory and knowledge management for Claude Code and other MCP clients. It uses OpenAI embeddings (or local HuggingFace/ONNX models) combined with Qdrant vector database to store, search, and manage memories. Features include automatic memory classification (long-term/episodic/short-term), secrets detection, workspace isolation, hybrid search (semantic + BM25 text), and LRU caching for cost optimization. Published to npm and GitHub Packages.

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

**Entry point** (`src/index.ts`): Initializes the MCP server, registers 9 tool handlers, and starts RulesManager to copy `rules/` into `.claude/rules/` on startup. When `EMBEDDING_PROVIDER=local`, preloads the HuggingFace/ONNX model in the background.

**Configuration** (`src/config.ts`): All environment variables are loaded and validated using Zod schemas. See `.env.example` for complete variable list. `QDRANT_URL` is the only required variable; embedding provider is auto-detected based on presence of `OPENAI_API_KEY`.

**Types** (`src/types/index.ts`): Shared interfaces including `MemoryType`, `MemoryMetadata`, `SearchResult`, `StandardResponse<T>`, `ErrorType`, `MCPTool`, `EmbeddingStats`, `QdrantPayload`, and `SearchFilters`.

**Schemas** (`src/schemas/memory-schemas.ts`): Zod schemas for all tool inputs, automatically generating JSON Schema for MCP registration. Validates `memory-store`, `memory-query`, `memory-list`, `memory-get`, `memory-update`, `memory-delete`, `memory-batch-delete`, `memory-status`, and `memory-count` inputs.

**Tools** (`src/tools/memory-tools.ts`): Implements 9 MCP tools for memory management. Each tool is registered with input schemas and returns `StandardResponse<T>` for MCP protocol compliance.

**Services** (singleton exports from `src/services/`):
- `QdrantService` — Vector database operations; stores two named vectors per point (`dense` for small embeddings, `dense_large` for large). Supports dense HNSW + sparse BM25 hybrid search with Reciprocal Rank Fusion (RRF).
- `EmbeddingService` — OpenAI embeddings (text-embedding-3-small/large) or local HuggingFace model with 10,000-entry LRU cache and cost tracking.
- `LocalEmbeddingProvider` — HuggingFace/ONNX CPU inference (default: `Xenova/all-MiniLM-L6-v2`, 384d). Model cached at `~/.cache/mcp-memory/models`; first call downloads ~20–140 MB depending on model.
- `SecretsDetector` — Blocks storage of 18+ secret patterns (API keys, tokens, passwords, etc.). High-confidence matches block immediately; 5+ distinct medium-confidence matches also block.
- `WorkspaceDetector` — Derives workspace name from env var → package.json → directory name. Reserved names (`system`, `admin`, `root`, etc.) are rejected.
- `RulesManager` — Copies `rules/*.md` into `.claude/rules/` at startup.

**Utilities** (`src/utils/`):
- `response.ts` — `successResponse()`, `errorResponse()`, `validationError()`, `notFoundError()` helpers for MCP protocol compliance.
- `logger.ts` — Singleton logger with `debug/info/warn/error` methods; level controlled by `LOG_LEVEL` env var.
- `retry.ts` — Exponential backoff retry logic for external API calls.
- `errors.ts` — Custom error types.

## Key Patterns

**Adding a new tool**: Define Zod schema in `src/schemas/memory-schemas.ts`, implement handler in `src/tools/memory-tools.ts`, register in `src/tools/index.ts`.

**Error handling**: Always return `successResponse()` or `errorResponse()` from tools. Use `validationError()` for schema violations and `notFoundError()` for missing memories — both produce the `StandardResponse` type expected by MCP clients.

**Chunking**: Content longer than the configured `MEMORY_CHUNK_SIZE` (default 1,000 chars) is auto-split into overlapping chunks. All chunks share a `chunk_group_id` UUID in metadata. `memory-update` blocks updates to individual chunks — must update via the group.

**Retry logic**: `src/utils/retry.ts` provides exponential backoff; used by both `QdrantService` and `EmbeddingService` for resilience against transient failures.

**Logging**: All significant operations log via `src/utils/logger.ts`. Control verbosity with `LOG_LEVEL` env var (debug/info/warn/error).

**Memory types**: Caller classifies memories into three types with different retention:
- `long-term` — Permanent storage (facts, decisions, workflows)
- `episodic` — 90 days (events, session outcomes)
- `short-term` — 7 days (working context, in-progress state)

Expired memories are automatically excluded from queries and listings.

## TypeScript Configuration

Project uses a 4-config split:

- **`tsconfig.json`** — Base/development configuration used by Vitest and editors. Includes all source files for full type checking.
- **`tsconfig.build.json`** — Production build configuration; explicitly excludes test files (`src/**/*.spec.ts`) and is used by the build script.
- **`tsconfig.test.json`** — Vitest test configuration.
- **`tsconfig.eslint.json`** — ESLint type-aware linting configuration.

Build command: `tsc` (uses `tsconfig.build.json` by default via `tsconfig.json` extends).

General configuration: Requires Node.js >= 24. Outputs to `./build/`, targets ES2022, module resolution `bundler`. Declaration files (`.d.ts`) and source maps are emitted alongside JS. Strict mode is fully enabled.

## CI/CD

Single workflow (`.github/workflows/ci.yml`) triggered on push to `main`, PRs to `main`, and `v*` tags:

- **All jobs**: Node pinned to 24, corepack enabled, `yarn install --immutable` for reproducible builds
- **Push to `main` / PR**: typecheck → lint → test → build
- **Push `v*` tag**: typecheck → lint → test → build → publish to GitHub Packages and npm (with provenance) → create GitHub Release

## Development Notes

**Qdrant Dependency**: Integration tests require a running Qdrant instance. Run locally via:

```bash
docker run -p 6333:6333 qdrant/qdrant
```

Or use `QDRANT_URL` env var to point to a cloud instance.

**Embedding Setup**: Either configure `OPENAI_API_KEY` for OpenAI embeddings, or leave unset to use local HuggingFace embeddings (downloads model on first use, ~20–140 MB cached).

**Rules Synchronization**: By default (`COPY_CLAUDE_RULES=true`), the server copies `rules/memory.md` into `.claude/rules/memory.md` on startup. This allows Claude Code to automatically load memory usage guidance as system context.

**Development Container**: A custom `.devcontainer/Dockerfile` is provided with Node.js environment and post-creation setup hook.
