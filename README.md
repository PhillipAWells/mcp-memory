# MCP Memory Server

[![GitHub Release](https://img.shields.io/github/v/release/PhillipAWells/mcp-memory)](https://github.com/PhillipAWells/mcp-memory/releases)
[![CI](https://github.com/PhillipAWells/mcp-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/PhillipAWells/mcp-memory/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/PhillipAWells?style=social)](https://github.com/sponsors/PhillipAWells)

Model Context Protocol (MCP) server for persistent memory and knowledge management using Qdrant vector database and OpenAI embeddings.

## Features

- **Semantic Search** - Vector-based search using OpenAI embeddings and Qdrant
- **Hybrid Search** - Combines text and semantic search with Reciprocal Rank Fusion (RRF)
- **Automatic Expiry** - Episodic memories expire after 90 days, short-term after 7 days
- **Workspace Isolation** - Multi-workspace support for organization-wide deployments
- **Secrets Detection** - Blocks storage of API keys, tokens, passwords, and other sensitive data
- **Dual Embeddings** - Small and large embedding vectors per memory for precision/recall trade-offs
- **Local Embeddings** - Runs fully offline via HuggingFace/ONNX — no API key required
- **Cost Optimization** - LRU caching and usage tracking for embedding API calls

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- Qdrant vector database (local or cloud)
- OpenAI API key *(optional — only needed for OpenAI embeddings; local embeddings work without one)*

### Installation

GitHub Packages requires authentication even for public packages. Authenticate once with a [personal access token](https://github.com/settings/tokens) that has `read:packages` scope:

```bash
# One-time: configure the registry for the @phillipawells scope
echo "@phillipawells:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT" >> ~/.npmrc
```

Then install and configure:

```bash
yarn install
cp .env.example .env
# Edit .env with your QDRANT_URL (and optionally OPENAI_API_KEY)
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
| `OPENAI_API_KEY` | *(optional)* | OpenAI API key — required only when `EMBEDDING_PROVIDER=openai` |
| `EMBEDDING_PROVIDER` | auto-detected | `openai` or `local`; defaults to `openai` if `OPENAI_API_KEY` is set, `local` otherwise |
| `LARGE_EMBEDDING_DIMENSIONS` | `3072` | Output dimensions for OpenAI `text-embedding-3-large` |
| `LOCAL_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model ID for local embeddings |
| `LOCAL_EMBEDDING_DIMENSIONS` | `384` | Output dimensions of the local model (must match model) |
| `LOCAL_EMBEDDING_CACHE_DIR` | `~/.cache/mcp-memory/models` | Cache directory for downloaded local models |

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
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `COPY_CLAUDE_RULES` | `true` | Copy `rules/` → `.claude/rules/` on startup |

## Local Embeddings (No API Key)

When `OPENAI_API_KEY` is not set, the server automatically uses the HuggingFace `Xenova/all-MiniLM-L6-v2` model via ONNX for CPU inference. The model (~22 MB) is downloaded on first use and cached at `~/.cache/mcp-memory/models`.

Alternative local models:

| Model | Dimensions | Size | Notes |
|---|---|---|---|
| `Xenova/all-MiniLM-L6-v2` | 384 | ~22 MB | Default, fast |
| `Xenova/bge-small-en-v1.5` | 384 | ~22 MB | Slightly better quality |
| `Xenova/bge-base-en-v1.5` | 768 | ~110 MB | Higher quality |

To switch models, set `LOCAL_EMBEDDING_MODEL` and `LOCAL_EMBEDDING_DIMENSIONS` to match.

> **Note:** Local and OpenAI embeddings are incompatible — switching providers after a collection is created requires re-indexing.

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

## Available Tools

| Tool | Description |
|---|---|
| `memory-store` | Store a memory with metadata and tags |
| `memory-query` | Semantic search with optional hybrid search |
| `memory-list` | List memories with filtering and pagination |
| `memory-get` | Retrieve a specific memory by ID |
| `memory-update` | Update memory content or metadata |
| `memory-delete` | Delete a memory by ID |
| `memory-batch-delete` | Delete multiple memories at once |
| `memory-status` | Health check, collection statistics, and embedding usage |
| `memory-count` | Count memories matching a filter |

## Architecture

```
MCP Client (Claude Code)
       ↓  stdio transport
MCP Server (src/index.ts)
       ↓
Tool Handlers (src/tools/memory-tools.ts)
       ↓
Services:
  ├── EmbeddingService  — OpenAI or local HuggingFace embeddings with LRU cache
  ├── QdrantService     — Vector DB operations, hybrid search
  ├── SecretsDetector   — Blocks sensitive data at store time
  ├── WorkspaceDetector — Derives workspace from env var → package.json → directory name
  └── RulesManager      — Copies rules/ → .claude/rules/ on startup
```

### Hybrid Search

When `use_hybrid_search: true`, results from dense vector search and sparse BM25 text search are merged using Reciprocal Rank Fusion (RRF) before applying the result limit. This improves recall for queries that mix exact terms with conceptual meaning.

## Agent Integration

By default (`COPY_CLAUDE_RULES=true`), the server copies `rules/memory.md` into `.claude/rules/` on startup, which Claude Code automatically loads as system prompt context. No manual setup is needed.

If you set `COPY_CLAUDE_RULES=false`, add the following to your project's `CLAUDE.md` manually:

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

## License

MIT — See [LICENSE](./LICENSE) for details.
