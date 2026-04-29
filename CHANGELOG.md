# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Batch processing for large embeddings (`generateBatchLargeEmbeddings()`) to improve performance
- `capped` and `uncapped_count` fields in `memory-list` response for transparent pagination handling
- Workspace validation at tool boundary to catch invalid workspaces early
- Error cause chain extraction in `extractErrorMessage()` for better debugging context
- TypeScript `isolatedModules` compiler option for stricter module boundaries

### Changed

- `memory-list` response now includes `capped: true` and `uncapped_count` when results truncated at 10,000 records
- `total_count` field now reflects effective count (capped) instead of approximate full count
- Qdrant service initialization now uses Promise memoization instead of boolean flag to prevent concurrent initialization
- Embedding stats counting now normalized across batch and single-item paths

### Fixed

- **C2**: Object serialization in error messages - `failedPoints` array now correctly mapped to IDs before joining
- **C1**: Large embedding API calls no longer called individually per chunk; now batched for efficiency
- **C3**: Pagination honesty - response now accurately reflects truncation at 10,000-record limit
- **M1**: CI pipeline - action versions updated from v6 (non-existent) to v4
- **M5**: Race condition in Qdrant service initialization eliminated via Promise memoization
- **M6**: MemoryError class now adopted in QdrantService.upsert() for proper error typing
- **M2**: TypeScript `isolatedModules` enabled for ESM compatibility
- **M3**: Embedding stats double-counting resolved by normalizing to public API boundary
- **M4**: Workspace validation errors now caught at tool handler boundary instead of silently falling back
- **M7**: Dependabot now groups runtime dependencies for cleaner PR management
- **m1**: Error messages now include full cause chain for better debugging (3-level recursion limit)
- **m2**: Added clarity comment on metadata check safety with Zod
- **m3**: Undefined vector fields now conditionally excluded from Qdrant payloads
- **m4-m5**: Removed inconsistent blank lines between JSDoc and method declarations
- **m6**: `hybrid_alpha` default value (0.5) now visible in JSON Schema
- **m7**: Added JSDoc for `sleep()` utility function
- **m9**: Added `clean` npm script for org standard compliance
- **m10**: Expanded `.npmignore` with explicit exclusion patterns
- **m11**: Documented redundant check in pagination handler as runtime defense
- **Documentation**: Added pagination limits explanation to AGENTS.md Common Gotchas section

### Security

- Improved error handling in Qdrant storage operations with proper error typing and cause chains

## [1.3.0] - 2026-04-24

### Added
- Comprehensive code review and quality improvements
- Enhanced test coverage (82%+ on core metrics)
- Proper access_count tracking in Qdrant operations

### Changed
- Removed async from synchronous RulesManager operations for efficiency
- Removed @internal annotation from public QdrantService.batchUpsert method
- Comprehensive code review and quality improvements across test suites
- Simplified QdrantPoint vector type to use only named vectors

### Fixed
- access_count corruption in updateAccessTracking method
- Type safety improvements (import type enforcement)
- Configuration validation (memory-update no-op prevention)

[Unreleased]: https://github.com/PhillipAWells/mcp-memory/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/PhillipAWells/mcp-memory/releases/tag/v1.3.0
