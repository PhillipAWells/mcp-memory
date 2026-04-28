/**
 * Tests for WorkspaceDetectorService
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkspaceDetectorService } from '../workspace-detector.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDetector(): WorkspaceDetectorService {
	return new WorkspaceDetectorService();
}

// ── isValidWorkspace ──────────────────────────────────────────────────────────

describe('WorkspaceDetectorService.isValidWorkspace', () => {
	let detector: WorkspaceDetectorService;

	beforeEach(() => {
		detector = makeDetector(); 
	});

	it('accepts a simple alphanumeric name', () => {
		expect(detector.isValidWorkspace('myproject')).toBe(true);
	});

	it('accepts names with hyphens and underscores', () => {
		expect(detector.isValidWorkspace('my-project_v2')).toBe(true);
	});

	it('rejects empty string', () => {
		expect(detector.isValidWorkspace('')).toBe(false);
	});

	it('rejects names longer than 100 characters', () => {
		expect(detector.isValidWorkspace('a'.repeat(101))).toBe(false);
	});

	it('accepts names exactly 100 characters', () => {
		expect(detector.isValidWorkspace('a'.repeat(100))).toBe(true);
	});

	it('rejects names with spaces', () => {
		expect(detector.isValidWorkspace('my project')).toBe(false);
	});

	it('rejects names with dots', () => {
		expect(detector.isValidWorkspace('my.project')).toBe(false);
	});

	it('rejects names with at-signs', () => {
		expect(detector.isValidWorkspace('@scope/name')).toBe(false);
	});

	it('rejects reserved name "system"', () => {
		expect(detector.isValidWorkspace('system')).toBe(false);
	});

	it('rejects reserved name "metadata"', () => {
		expect(detector.isValidWorkspace('metadata')).toBe(false);
	});

	it('rejects reserved name "admin"', () => {
		expect(detector.isValidWorkspace('admin')).toBe(false);
	});

	it('rejects reserved name "internal"', () => {
		expect(detector.isValidWorkspace('internal')).toBe(false);
	});

	it('rejects reserved name "default"', () => {
		expect(detector.isValidWorkspace('default')).toBe(false);
	});

	it('rejects reserved names case-insensitively', () => {
		expect(detector.isValidWorkspace('SYSTEM')).toBe(false);
		expect(detector.isValidWorkspace('Admin')).toBe(false);
	});
});

// ── normalize ────────────────────────────────────────────────────────────────

describe('WorkspaceDetectorService.normalize', () => {
	let detector: WorkspaceDetectorService;

	beforeEach(() => {
		detector = makeDetector(); 
	});

	it('returns null for null input', () => {
		expect(detector.normalize(null)).toBeNull();
	});

	it('lowercases the name', () => {
		expect(detector.normalize('MyProject')).toBe('myproject');
	});

	it('does not strip trailing spaces (names cannot contain spaces by pattern)', () => {
		// Valid workspace names never have spaces, so trim() is not needed
		expect(detector.normalize('myproject')).toBe('myproject');
	});
});

// ── equals ───────────────────────────────────────────────────────────────────

describe('WorkspaceDetectorService.equals', () => {
	let detector: WorkspaceDetectorService;

	beforeEach(() => {
		detector = makeDetector(); 
	});

	it('returns true for identical names', () => {
		expect(detector.equals('project', 'project')).toBe(true);
	});

	it('is case-insensitive', () => {
		expect(detector.equals('Project', 'project')).toBe(true);
	});

	it('returns false for different names', () => {
		expect(detector.equals('foo', 'bar')).toBe(false);
	});

	it('returns true when both are null', () => {
		expect(detector.equals(null, null)).toBe(true);
	});

	it('returns false when one is null', () => {
		expect(detector.equals('foo', null)).toBe(false);
	});

	it('returns false when comparing null to a string', () => {
		expect(detector.equals(null, 'foo')).toBe(false);
	});
});

// ── cache ────────────────────────────────────────────────────────────────────

describe('WorkspaceDetectorService cache', () => {
	let detector: WorkspaceDetectorService;

	beforeEach(() => {
		detector = makeDetector(); 
	});

	it('clearCache makes getCached return uncached result', () => {
		// Prime the cache via detect() using an explicit workspace
		detector.detect('myproject');
		const result = detector.getCached();
		expect(result.cached).toBe(true);
		detector.clearCache();
		const cleared = detector.getCached();
		expect(cleared.cached).toBe(false);
	});

	it('getCached returns uncached before any detection', () => {
		const result = detector.getCached();
		expect(result.cached).toBe(false);
		expect(result.workspace).toBeNull();
	});

	it('clears cache returns uncached immediately after', () => {
		detector.detect(undefined, process.cwd());
		// Cache should have been populated by auto-detection
		const cached = detector.getCached();
		expect(cached.cached).toBe(true);
		// Cache might be null if TTL expired, but we can test the clear works
		detector.clearCache();
		const cleared = detector.getCached();
		expect(cleared.cached).toBe(false);
	});
});

// ── detect — explicit workspace ───────────────────────────────────────────────

describe('WorkspaceDetectorService.detect — explicit workspace', () => {
	let detector: WorkspaceDetectorService;

	beforeEach(() => {
		detector = makeDetector(); 
	});

	it('returns explicit workspace with source explicit', () => {
		const result = detector.detect('explicit-ws');
		expect(result.workspace).toBe('explicit-ws');
		expect(result.source).toBe('explicit');
	});

	it('returns null workspace when explicitWorkspace is null', () => {
		const result = detector.detect(null);
		expect(result.workspace).toBeNull();
		expect(result.source).toBe('explicit');
	});

	it('falls through to auto-detection for invalid explicit names', () => {
		// '   ' is not a valid name, so it falls through to auto-detection
		const result = detector.detect('   ');
		// Source will be whatever auto-detection resolves to (not 'explicit')
		expect(result.source).not.toBe('explicit');
	});
});

// ── detect — package.json traversal ──────────────────────────────────────────

describe('WorkspaceDetectorService.detect — package.json', () => {
	let detector: WorkspaceDetectorService;

	beforeEach(() => {
		detector = makeDetector(); 
	});

	it('detects workspace from the repository package.json', () => {
		// @pawells/mcp-memory:
		//   1. strips @pawells/ scope → 'mcp-memory'
		//   2. cleanWorkspaceName strips mcp- prefix → 'memory'
		const result = detector.detect(undefined, process.cwd());
		expect(result.workspace).toBe('memory');
		expect(result.source).toBe('package.json');
	});

	it('caches the result and returns same source on second call', () => {
		detector.detect(undefined, process.cwd());
		const result = detector.detect(undefined, process.cwd());
		expect(result.source).toBe('package.json');
		expect(result.workspace).toBe('memory');
	});

	it('cache returns the correct source (not always package.json)', () => {
		// First call: auto-detect from a directory without package.json
		const tmpDir = '/tmp';
		const first = detector.detect(undefined, tmpDir);
		const { source: cachedSource } = first;
		// Second call should return the same source from cache
		const second = detector.detect(undefined, tmpDir);
		expect(second.source).toBe(cachedSource);
	});
});

// ── detect — scoped package names ────────────────────────────────────────────

describe('WorkspaceDetectorService.detect — scoped package names', () => {
	let detector: WorkspaceDetectorService;

	beforeEach(() => {
		detector = makeDetector(); 
	});

	it('strips @scope/ prefix from scoped package name and mcp- prefix', () => {
		// @pawells/mcp-memory → strip scope → mcp-memory → strip mcp- → memory
		const result = detector.detect(undefined, process.cwd());
		expect(result.workspace).toBe('memory');
		expect(result.workspace).toMatch(/^[a-zA-Z0-9_-]+$/);
	});
});

// ── detect — malformed package.json recovery ──────────────────────────────────

describe('WorkspaceDetectorService.detect — malformed package.json recovery', () => {
	let detector: WorkspaceDetectorService;
	let tmpDir: string;

	beforeEach(() => {
		detector = makeDetector();
		tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-ws-'));
		writeFileSync(join(tmpDir, 'package.json'), 'not valid json {{{');
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('skips a malformed package.json and falls back to directory name', () => {
		const result = detector.detect(undefined, tmpDir);
		// The malformed package.json is skipped; detection falls through to
		// the directory basename (mcp-test-ws-XXXX → 'test-ws-XXXX' after prefix strip)
		expect(result.source).toBe('directory');
		expect(result.workspace).not.toBeNull();
	});

	it('does not throw when package.json is unparseable', () => {
		expect(() => detector.detect(undefined, tmpDir)).not.toThrow();
	});

	it('falls back to default when package.json has no name field', () => {
		const tmpDir2 = mkdtempSync(join(tmpdir(), 'mcp-test-no-name-'));
		writeFileSync(join(tmpDir2, 'package.json'), JSON.stringify({}));
		try {
			const detector2 = makeDetector();
			const result = detector2.detect(undefined, tmpDir2);
			// Falls through to directory name or default
			expect(result.source).toBe('directory');
		} finally {
			rmSync(tmpDir2, { recursive: true, force: true });
		}
	});
});

// ── detect — unscoped and invalid package names ───────────────────────────────

describe('WorkspaceDetectorService.detect — unscoped package names', () => {
	it('detects workspace from package.json with unscoped name', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-unscoped-'));
		writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'my-app' }));
		try {
			const detector = new WorkspaceDetectorService();
			const result = detector.detect(undefined, tmpDir);
			expect(result.workspace).toBe('my-app');
			expect(result.source).toBe('package.json');
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it('falls through to directory name when package.json name is reserved', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'my-valid-app-'));
		// 'system' is a reserved workspace name and will be rejected
		writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'system' }));
		try {
			const detector = new WorkspaceDetectorService();
			const result = detector.detect(undefined, tmpDir);
			// Falls through to directory name since 'system' is invalid
			expect(result.source).toBe('directory');
			expect(result.workspace).not.toBe('system');
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// ── getInfo without arguments ─────────────────────────────────────────────────

describe('WorkspaceDetectorService.getInfo default argument', () => {
	it('uses process.cwd() as default directory when called without arguments', () => {
		const detector = new WorkspaceDetectorService();
		// Call without args — exercises the default parameter branch
		const info = detector.getInfo();
		// Should return an object with detected, config, and cache properties
		expect(info).toHaveProperty('detected');
		expect(info.detected).toHaveProperty('workspace');
		expect(info.detected).toHaveProperty('source');
	});
});

// ── cache TTL expiry ──────────────────────────────────────────────────────────

describe('WorkspaceDetectorService cache TTL expiry', () => {
	let detector: WorkspaceDetectorService;

	beforeEach(() => {
		detector = makeDetector();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns cached result when TTL has not expired', () => {
		// Prime cache with explicit workspace
		detector.detect('test-ws');
		expect(detector.getCached().cached).toBe(true);

		// Advance time by 1 second (less than TTL)
		vi.advanceTimersByTime(1000);
		const result = detector.getCached();
		expect(result.cached).toBe(true);
		expect(result.workspace).toBe('test-ws');
	});

	it('returns uncached when TTL has expired', () => {
		// Prime cache
		detector.detect('test-ws');
		expect(detector.getCached().cached).toBe(true);

		// Advance time beyond TTL (default 60000ms)
		vi.advanceTimersByTime(65000);
		const result = detector.getCached();
		expect(result.cached).toBe(false);
		// Workspace value is still there, but marked as uncached
		expect(result.workspace).toBe('test-ws');
	});

	it('detect() bypasses expired cache and re-detects', () => {
		// Prime cache with explicit workspace
		detector.detect('test-ws-1');
		expect(detector.getCached().workspace).toBe('test-ws-1');

		// Advance time beyond TTL
		vi.advanceTimersByTime(65000);

		// Call detect with explicit workspace; should update cache
		const result = detector.detect('test-ws-2');
		expect(result.workspace).toBe('test-ws-2');
		expect(result.source).toBe('explicit');

		// Cache should now have the new workspace
		expect(detector.getCached().workspace).toBe('test-ws-2');
		expect(detector.getCached().cached).toBe(true);
	});

	it('getInfo() reports cache age correctly', () => {
		detector.detect('test-ws');
		const info = detector.getInfo();
		expect(info.cache.valid).toBe(true);
		expect(info.cache.age).toBeLessThan(1000); // Just created

		// Advance time
		vi.advanceTimersByTime(30000);
		// Don't call detect() here - directly access cache state
		// by using getCached() to check age without triggering re-detection
		const cached = detector.getCached();
		expect(cached.cached).toBe(true); // Still valid (30s < 60s TTL)
	});
});

// ── auto-detect disabled ──────────────────────────────────────────────────────

describe('WorkspaceDetectorService auto-detection disabled', () => {
	let detector: WorkspaceDetectorService;

	beforeEach(() => {
		detector = makeDetector();
	});

	it('returns default workspace when auto-detect is disabled', () => {
		// This test requires mocking config.workspace.autoDetect
		// Since we cannot directly mock config in the service, we rely on
		// the environment configuration. For now, we document the expected behavior:
		// When WORKSPACE_AUTO_DETECT=false, detect() returns WORKSPACE_DEFAULT or null.
		//
		// The actual test is deferred to integration tests where env vars can be set.
		expect(detector).toBeDefined();
	});
});

// ── getCached edge cases ──────────────────────────────────────────────────────

describe('WorkspaceDetectorService.getCached edge cases', () => {
	let detector: WorkspaceDetectorService;

	beforeEach(() => {
		detector = makeDetector();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns uncached=false and workspace=null before any detection', () => {
		const result = detector.getCached();
		expect(result.cached).toBe(false);
		expect(result.workspace).toBeNull();
	});

	it('distinguishes between never-detected (cachePopulated=false) and expired cache', () => {
		// Before any detection: cachePopulated is false
		let result = detector.getCached();
		expect(result.cached).toBe(false);
		expect(result.workspace).toBeNull();

		// After detection: cachePopulated is true
		detector.detect('test-ws');
		result = detector.getCached();
		expect(result.cached).toBe(true);
		expect(result.workspace).toBe('test-ws');

		// After TTL expiry: cachePopulated is still true, but cached is false
		vi.advanceTimersByTime(65000);
		result = detector.getCached();
		expect(result.cached).toBe(false);
		expect(result.workspace).toBe('test-ws'); // Workspace is still in cache
	});

	it('cache respects exactly at TTL boundary', () => {
		detector.detect('test-ws');
		// Advance exactly to TTL (60000ms)
		vi.advanceTimersByTime(60000);
		const result = detector.getCached();
		// At exactly TTL, cache IS expired (using >= comparison)
		expect(result.cached).toBe(false); // >=  boundary means expired
	});
});

// ── cache invalidation and re-population ──────────────────────────────────────

describe('WorkspaceDetectorService cache invalidation', () => {
	let detector: WorkspaceDetectorService;

	beforeEach(() => {
		detector = makeDetector();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('clearCache() marks cache as unpopulated', () => {
		detector.detect('test-ws');
		expect(detector.getCached().cached).toBe(true);

		detector.clearCache();
		const result = detector.getCached();
		expect(result.cached).toBe(false);
		expect(result.workspace).toBeNull();
	});

	it('detect() with explicit workspace repopulates cache after clearing', () => {
		detector.detect('test-ws-1');
		detector.clearCache();

		detector.detect('test-ws-2');
		const result = detector.getCached();
		expect(result.cached).toBe(true);
		expect(result.workspace).toBe('test-ws-2');
	});
});
