# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-04-24

### Added
- Comprehensive code review and quality improvements
- Enhanced test coverage (82%+ on core metrics)
- Proper access_count tracking in Qdrant operations
- Custom MCPMemoryError class with code property for error handling

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
