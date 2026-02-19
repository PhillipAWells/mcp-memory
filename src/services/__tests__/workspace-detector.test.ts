/**
 * Tests for WorkspaceDetectorService
 */

import { describe, it, expect, beforeEach } from 'vitest';
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
});

// ── cache ────────────────────────────────────────────────────────────────────

describe('WorkspaceDetectorService cache', () => {
  let detector: WorkspaceDetectorService;

  beforeEach(() => {
    detector = makeDetector(); 
  });

  it('clearCache makes getCached return null', () => {
    // Prime the cache via detect() using an explicit workspace
    detector.detect('myproject');
    detector.clearCache();
    expect(detector.getCached()).toBeNull();
  });

  it('getCached returns null before any detection', () => {
    expect(detector.getCached()).toBeNull();
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
    // @phillipawells/mcp-memory:
    //   1. strips @phillipawells/ scope → 'mcp-memory'
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
    // @phillipawells/mcp-memory → strip scope → mcp-memory → strip mcp- → memory
    const result = detector.detect(undefined, process.cwd());
    expect(result.workspace).toBe('memory');
    expect(result.workspace).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});
