# MCP Memory Server

[![GitHub Release](https://img.shields.io/github/v/release/PhillipAWells/mcp-memory)](https://github.com/PhillipAWells/mcp-memory/releases)
[![CI](https://github.com/PhillipAWells/mcp-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/PhillipAWells/mcp-memory/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/PhillipAWells?style=social)](https://github.com/sponsors/PhillipAWells)

## Description

`@pawells/mcp-memory` is a Model Context Protocol (MCP) server that provides persistent semantic memory and knowledge management for Claude Code and other AI agents. It combines OpenAI embeddings with Qdrant vector database to enable hybrid search (dense vectors + keyword indexing) with automatic memory expiry, workspace isolation, and comprehensive secrets detection to prevent accidental storage of sensitive credentials.

## Features

- **Semantic Search** - Vector-based search using OpenAI embeddings and Qdrant
- **Hybrid Search** - Combines text and semantic search with Reciprocal Rank Fusion (RRF)
- **Automatic Expiry** - Episodic memories expire after 90 days, short-term after 7 days
- **Workspace Isolation** - Multi-workspace support for organization-wide deployments
- **Secrets Detection** - Blocks storage of API keys, tokens, passwords, and other sensitive data
- **Dual Embeddings** - Small and large embedding vectors per memory for precision/recall trade-offs
- **Cost Optimization** - LRU caching and usage tracking for embedding API calls
- **Corporate Proxy Support** — Routes all outbound traffic through HTTP(S) proxies via standard `HTTPS_PROXY` / `HTTP_PROXY` env vars; `NO_PROXY` defaults to `localhost,127.0.0.1,::1` automatically

## Requirements

- Node.js >= 22.0.0
- Qdrant vector database (local or cloud)
- OpenAI API key (**required**)

## Quick Start

### Installation

```bash
npm install -g @pawells/mcp-memory
```

Then configure:

```bash
cp .env.example .env
# Edit .env with your QDRANT_URL and OPENAI_API_KEY
```

### Running Qdrant Locally

```bash
docker run -p 6333:6333 qdrant/qdrant
```

### Development

```bash
yarn build          # Compile TypeScript
yarn start          # Run the server
yarn dev            # Build + run
yarn typecheck      # Type check without building
yarn watch          # Watch mode
yarn test           # Run tests
```

## Configuration

### OpenAI / Embeddings

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | *(required)* | OpenAI API key |
| `LARGE_EMBEDDING_DIMENSIONS` | `3072` | Output dimensions for OpenAI `text-embedding-3-large` |

### Qdrant

| Variable | Default | Description |
|---|---|---|
| `QDRANT_URL` | `http://localhost:6333` | Qdrant server URL |
| `QDRANT_API_KEY` | *(optional)* | API key for Qdrant Cloud |
| `QDRANT_COLLECTION` | `mcp-memory` | Collection name |
| `QDRANT_TIMEOUT` | `30000` | Request timeout in milliseconds |

### Memory

| Variable | Default | Description |
|---|---|---|
| `MEMORY_CHUNK_SIZE` | `1000` | Chunk size in characters for long documents |
| `MEMORY_CHUNK_OVERLAP` | `200` | Overlap between adjacent chunks in characters |

### Workspace

| Variable | Default | Description |
|---|---|---|
| `WORKSPACE_AUTO_DETECT` | `true` | Auto-detect workspace from context |
| `WORKSPACE_DEFAULT` | *(optional)* | Default workspace name |
| `WORKSPACE_CACHE_TTL` | `60000` | Workspace cache TTL in milliseconds |

### Server

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error`, `silent` |
| `COPY_CLAUDE_RULES` | `true` | Copy `rules/` → `.claude/rules/` on startup |

### Proxy

For environments behind a corporate firewall, set the standard proxy environment variables. All outbound traffic — OpenAI API calls and Qdrant requests — is automatically routed through the configured proxy.

| Variable | Default | Description |
|---|---|---|
| `HTTPS_PROXY` | *(unset)* | Proxy URL for HTTPS traffic (e.g. `http://proxy.corp.com:8080`) |
| `HTTP_PROXY` | *(unset)* | Proxy URL for HTTP traffic |
| `NO_PROXY` | `localhost,127.0.0.1,::1` | Comma-separated hostnames/IPs to bypass the proxy. Defaults to local addresses when a proxy is active, preventing Qdrant (typically on `localhost`) from being routed through the proxy. |

> Lowercase variants (`https_proxy`, `http_proxy`, `no_proxy`) are also accepted. Uppercase takes priority.
>
> `NO_PROXY` is **only auto-defaulted when a proxy is active** — if no proxy is configured, `NO_PROXY` is left untouched.

## Memory Types

The caller is responsible for classifying memories and providing tags. Three types are supported:

| Type | Retention | Use for |
|---|---|---|
| `long-term` | Permanent | Facts, knowledge, decisions, workflows |
| `episodic` | 90 days | Events, experiences, session outcomes |
| `short-term` | 7 days | Working context, in-progress state |

Expired memories are automatically excluded from all queries and listings.

## Metadata Schema

```typescript
{
  memory_type: 'long-term' | 'episodic' | 'short-term',
  workspace: string | null,
  confidence: number,   // 0.0–1.0
  expires_at: string,   // ISO 8601, auto-set based on memory_type
  tags: string[],       // Caller-provided, used for categorization and filtering
}
```

## API Reference

All tools are exposed over the MCP stdio transport and return a `StandardResponse<T>` envelope.

### `memory-store`

Store a memory with metadata and tags.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | `string` | Yes | Text content to embed and store (1–100 000 characters) |
| `metadata.memory_type` | `'long-term' \| 'episodic' \| 'short-term'` | No | Classification controlling retention policy |
| `metadata.workspace` | `string` | No | Workspace slug for multi-project isolation |
| `metadata.confidence` | `number` | No | Reliability score in [0, 1] |
| `metadata.tags` | `string[]` | No | Up to 20 searchable tags (each 1–50 characters) |
| `auto_chunk` | `boolean` | No | Split content longer than 1 000 characters into overlapping chunks (default `true`) |

### `memory-query`

Semantic search with optional hybrid search.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | `string` | Yes | Natural-language search query (1–10 000 characters) |
| `filter.workspace` | `string` | No | Restrict results to a workspace |
| `filter.memory_type` | `'long-term' \| 'episodic' \| 'short-term'` | No | Restrict results to a memory type |
| `filter.min_confidence` | `number` | No | Minimum confidence score in [0, 1] |
| `filter.tags` | `string[]` | No | Restrict results to memories with all specified tags |
| `limit` | `number` | No | Maximum results to return (1–100, default 10) |
| `offset` | `number` | No | Results to skip for pagination (default 0) |
| `score_threshold` | `number` | No | Minimum cosine similarity score in [0, 1] |
| `hnsw_ef` | `number` | No | HNSW search thoroughness parameter (64–512) |
| `use_hybrid_search` | `boolean` | No | Combine vector and full-text search via RRF (default `false`) |
| `hybrid_alpha` | `number` | No | Weight between dense (1.0) and full-text (0.0) scoring in hybrid mode (default 0.5) |

### `memory-list`

List memories with filtering and pagination.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `filter.workspace` | `string` | No | Restrict results to a workspace |
| `filter.memory_type` | `'long-term' \| 'episodic' \| 'short-term'` | No | Restrict results to a memory type |
| `filter.min_confidence` | `number` | No | Minimum confidence score in [0, 1] |
| `filter.tags` | `string[]` | No | Restrict results to memories with all specified tags |
| `limit` | `number` | No | Memories per page (1–1 000, default 100) |
| `offset` | `number` | No | Memories to skip for pagination (default 0) |
| `sort_by` | `'created_at' \| 'updated_at' \| 'access_count' \| 'confidence'` | No | Sort field (default `'created_at'`) |
| `sort_order` | `'asc' \| 'desc'` | No | Sort direction (default `'desc'`) |

### `memory-get`

Retrieve a specific memory by ID.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | UUID of the memory to retrieve |

### `memory-update`

Update memory content or metadata. At least one of `content` or `metadata` must be provided.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | UUID of the memory to update |
| `content` | `string` | No | Replacement content; triggers embedding regeneration (1–100 000 characters) |
| `metadata` | `object` | No | Metadata fields to merge into the existing payload |
| `auto_chunk` | `boolean` | No | Split content into overlapping chunks (default `true`) |

### `memory-delete`

Delete a memory by ID.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | UUID of the memory to delete |

### `memory-batch-delete`

Delete multiple memories in a single call.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ids` | `string[]` | Yes | Array of UUIDs to delete (1–100 items) |

### `memory-status`

Health check, collection statistics, and embedding usage.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspace` | `string` | No | Include per-workspace point count for the specified workspace |
| `include_embedding_stats` | `boolean` | No | Include embedding cache and cost statistics (default `true`) |

### `memory-count`

Count memories matching a filter.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `filter.workspace` | `string` | No | Restrict count to a workspace |
| `filter.memory_type` | `'long-term' \| 'episodic' \| 'short-term'` | No | Restrict count to a memory type |
| `filter.min_confidence` | `number` | No | Minimum confidence score in [0, 1] |
| `filter.tags` | `string[]` | No | Restrict count to memories with all specified tags |

## Architecture

```
MCP Client (Claude Code)
       ↓  stdio transport
MCP Server (src/index.ts)
       ↓
Tool Handlers (src/tools/memory-tools.ts)
       ↓
Services:
  ├── EmbeddingService  — OpenAI embeddings (small + large) with LRU cache
  ├── QdrantService     — Vector DB operations, hybrid search
  ├── SecretsDetector   — Blocks sensitive data at store time
  ├── WorkspaceDetector — Derives workspace from env var → package.json → directory name
  └── RulesManager      — Copies rules/ → .claude/rules/ on startup
```

### Hybrid Search

When `use_hybrid_search: true`, results from dense HNSW vector similarity search and Qdrant keyword full-text index search are merged using Reciprocal Rank Fusion (RRF) before applying the result limit. This improves recall for queries that mix exact terms with conceptual meaning.

> **Note:** The text component uses Qdrant's keyword tokenizer for word-level full-text matching, not statistical BM25 scoring.

## Agent Integration

By default (`COPY_CLAUDE_RULES=true`), the server copies `rules/memory.md` into `.claude/rules/` on startup, which Claude Code automatically loads as system prompt context. No manual setup is needed.

If you set `COPY_CLAUDE_RULES=false`, add the following to your project's `AGENTS.md` (or `CLAUDE.md`) manually:

### Minimal

```markdown
## Memory

This project uses mcp-memory. Follow this workflow:

**Before acting:** Query memory for relevant context using `memory-query`.
**After acting:** Store new knowledge with `memory-store`. Check for duplicates first — update existing memories rather than duplicating.

**Workspace:** `{PROJECT_NAME}`
**Memory types:** `long-term` (permanent), `episodic` (90d), `short-term` (7d)
**Tags:** descriptive keywords for the content (e.g. `authentication`, `postgres`, `debugging`)
**Confidence:** calibrated to source — verified (0.95+), inferred (0.65–0.75), uncertain (0.50)
```

### Full

```markdown
## Memory

This project uses mcp-memory for persistent knowledge across sessions.

### Query First

Before responding to any request:
1. Query memory for relevant context using `memory-query`
2. If memory is insufficient, search the web and store findings before responding

### Store After Acting

After every meaningful exchange, store:
- Decisions made and their rationale
- Problems solved and root causes
- Patterns and conventions established
- Failures and dead-ends
- User preferences and feedback

Check for duplicates before storing — update existing memories rather than duplicating.

### Metadata

- **Workspace:** `{PROJECT_NAME}`
- **Tags:** specific keywords for the content (e.g. `["authentication", "jwt", "race-condition"]`)
- **Memory type:** `long-term` (permanent), `episodic` (90d), `short-term` (7d)
- **Confidence:** 0.95+ verified, 0.65–0.75 inferred, 0.50 uncertain
```

### Troubleshooting

**Memory tools not responding** — Run `memory-status` to verify the MCP server is reachable; check `QDRANT_URL` and that Qdrant is running.

**Poor query results** — Try different phrasings; check whether a workspace filter is excluding relevant memories; lower `score_threshold` if results are sparse.

**Storage rejected** — Content likely contains a detected secret; sanitize and retry.

**Requests timing out or failing behind a corporate firewall** — Set `HTTPS_PROXY=http://proxy.corp.com:8080` (and optionally `HTTP_PROXY`). The server routes all traffic through the proxy automatically. Run with `LOG_LEVEL=debug` to confirm proxy is active at startup.

**Proxy is set but Qdrant requests fail** — Check that Qdrant's hostname is covered by `NO_PROXY`. The server defaults `NO_PROXY` to `localhost,127.0.0.1,::1` automatically, but if Qdrant is reachable under a different hostname you must add it explicitly.

## License

MIT — See [LICENSE](./LICENSE) for details.
