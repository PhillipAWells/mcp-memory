# Memory

Guide for using the mcp-memory MCP tools to store and retrieve persistent knowledge across sessions.

---

## Core Workflow

```
Query → Act → Store
```

1. **Query** — Before acting on a request, query memory for relevant context
2. **Act** — Use retrieved knowledge to inform your response
3. **Store** — After acting, persist new knowledge (check for duplicates first)

---

## Querying

Use the `memory-query` tool to search semantic memory.

### When to Query

- Before answering technical questions or making architectural decisions
- Before implementing a feature (check for established patterns)
- When debugging (check similar past issues)
- At session start to load project context
- When researching a new topic (query first, web search if insufficient)

### Direct vs Subagent

**Call `memory-query` directly** for simple, targeted lookups where you expect a small result set.

**Use a subagent** when results may be extensive or require synthesis across multiple memories. The subagent processes results in its own context, returning only distilled insights and keeping your context clean.

### Subagent Prompt Template

```
Query memory about: {TOPIC}
Context: {CURRENT_SITUATION}

1. Use memory-query to search for {TOPIC}
2. Run additional queries with different phrasings if initial results are sparse
3. If memory is insufficient, use WebSearch to fill the gap, then store findings with memory-store
4. Synthesize results — return only what's relevant to the context
5. Note any conflicting memories
6. Include IDs for memories likely to need updating later

Do not dump raw results. Analyze and distill.
```

### Examples

**Architecture decision:**
```
Query: "authentication approach JWT vs sessions"

Result: "Previously chose JWT for stateless scaling. Session attempt
failed (Redis memory limits under load). Pattern: 15min expiry +
httpOnly refresh tokens. Critical: validate token after user load
to avoid race condition. IDs: abc-123, def-456"
```

**No results → web search → store:**
```
Query: "webhook handling patterns"

No memories found → WebSearch → synthesized best practices:
verify signatures, idempotency keys, async processing, exponential backoff.
Stored as long-term memory (ID: xyz-789) for future recall.
```

---

## Storing

Use the `memory-store` tool to persist knowledge for future sessions.

### When to Store

- Decisions made, with rationale
- Problems solved and their root cause
- Patterns, conventions, and preferences established
- Failed approaches and why they failed
- Gotchas, edge cases, and surprises
- When the user explicitly asks to remember something

When uncertain whether something is worth storing — store it. Knowledge loss is more costly than storage.

### Check for Duplicates First

Before creating a new memory, query to check if a similar one exists:
- Similar exists → update with `memory-update` instead of creating a duplicate
- Not found → create with `memory-store`

### Metadata

Provide these fields when storing:

**`memory_type`**
- `long-term` — Facts, decisions, patterns, architectural knowledge (permanent)
- `episodic` — Events, experiences, session outcomes (expires 90 days)
- `short-term` — Working context, in-progress state (expires 7 days)

**`tags`** — Keywords used for filtering and future retrieval. Be specific:
```
["authentication", "jwt", "security"]
["postgres", "database", "migration"]
["debugging", "race-condition", "auth-middleware"]
```

**`confidence`** — How certain you are the information is accurate (0.0–1.0). Calibrate to the source, not to the importance of the information.

| Range | Label | When to use |
|---|---|---|
| 0.95–1.0 | Certain | Directly observed, verified by running code, confirmed by official docs |
| 0.80–0.94 | High | Strong inference from reliable sources, consistent with multiple observations |
| 0.60–0.79 | Moderate | Reasoned from partial information, single source, not yet verified |
| 0.40–0.59 | Low | Uncertain recollection, conflicting signals, second-hand account |
| 0.00–0.39 | Speculative | Rumour, guess, or information that may be outdated |

Rules of thumb:
- Ran the code and it worked → 0.95+
- Read in official documentation → 0.90
- Inferred from context → 0.65–0.75
- User told you, unverified → 0.60
- Genuinely unsure → 0.50

Prefer a lower honest score over a higher optimistic one. Overconfident memories mislead future queries more than underconfident ones.

### What Not to Store

- Sensitive secrets (API keys, passwords, tokens) — automatically blocked by the tool
- Information that changes every few minutes
- Exact duplicates stored in the last few minutes

### Secrets Detection

The store tool automatically blocks content containing API keys, auth tokens, private keys, database URLs with credentials, passwords, and similar sensitive patterns. Use placeholders instead:

```
✗  "Our API key is sk-abc123..."
✓  "API key stored in .env as OPENAI_API_KEY"

✗  "DB: postgres://user:pass@host/db"
✓  "DB connection via DATABASE_URL env var"
```

---

## Statistics

Use `memory-stats` to inspect the memory collection.

**Output includes:**
- Total memory count and breakdown by type (long-term / episodic / short-term)
- Per-workspace counts
- Embedding usage: API calls, tokens, costs, cache hit rate
- Qdrant collection health and optimizer status

Useful for checking capacity, monitoring costs, and diagnosing storage issues.

**Healthy system indicators:**
- Memory count grows steadily over sessions
- Decreasing need to re-explain context across sessions
- Topics that required web search on day 1 are answered from memory on day 2

**Warning signs:**
- Memory count flat across multiple sessions
- Same questions asked repeatedly
- No record of failed approaches or gotchas

