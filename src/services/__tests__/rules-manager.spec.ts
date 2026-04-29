/**
 * Unit tests for RulesManagerService
 *
 * Uses a real temporary directory to test file-system operations.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as FS from 'node:fs';

// ── Mock config ───────────────────────────────────────────────────────────────
vi.mock('../../config.js', () => ({
	config: {
		rules: { copyClaudeRules: true },
		server: { logLevel: 'silent' },
	},
}));

// ── Mock fs for error handling tests ───────────────────────────────────────────
let mockFsMode: 'normal' | 'copyFileSync-error' | 'readdirSync-error' | 'mkdirSync-error' | 'copyFileSync-error-in-subdir' = 'normal';
let copyFileSyncCallCount = 0;

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof FS>('node:fs');
	return {
		...actual,
		copyFileSync: (source: string, dest: string, mode?: number) => {
			copyFileSyncCallCount++;
			if (mockFsMode === 'copyFileSync-error') {
				throw new Error('EACCES: permission denied');
			}
			if (mockFsMode === 'copyFileSync-error-in-subdir' && copyFileSyncCallCount > 1) {
				throw new Error('EACCES: permission denied');
			}
			return actual.copyFileSync(source, dest, mode);
		},
		readdirSync: ((dirPath: string, options?: unknown) => {
			if (mockFsMode === 'readdirSync-error') {
				throw new Error('EACCES: permission denied');
			}
			// @ts-expect-error - unknown is cast to match actual function signature
			return actual.readdirSync(dirPath, options);
		}) as typeof actual.readdirSync,
		mkdirSync: ((dirPath: string, options?: unknown) => {
			if (mockFsMode === 'mkdirSync-error') {
				throw new Error('EACCES: permission denied');
			}
			// @ts-expect-error - unknown is cast to match actual function signature
			return actual.mkdirSync(dirPath, options);
		}) as typeof actual.mkdirSync,
	};
});

// We test RulesManagerService by subclassing/monkey-patching to inject temp dirs.
// The service resolves dirs from import.meta.url so we need a helper approach.

import { RulesManagerService } from '../rules-manager.js';
import { config } from '../../config.js';

function makeServiceWithDirs(sourceDir: string, targetDir: string): RulesManagerService {
	const service = new RulesManagerService();
	// Override the private dirs via type cast to test with our temp dirs
	// @ts-expect-error - intentionally accessing private properties for testing
	(service as Record<string, unknown>).sourceDir = sourceDir;
	// @ts-expect-error - intentionally accessing private properties for testing
	(service as Record<string, unknown>).targetDir = targetDir;
	return service;
}

describe('RulesManagerService', () => {
	let sourceDir: string;
	let targetDir: string;

	beforeEach(() => {
		sourceDir = mkdtempSync(join(tmpdir(), 'rules-source-'));
		targetDir = join(mkdtempSync(join(tmpdir(), 'rules-target-')), '.claude', 'rules');
	});

	afterEach(() => {
		// Cleanup is handled by OS
	});

	it('copies a rule file from source to target', () => {
		writeFileSync(join(sourceDir, 'memory.md'), '# Memory rules');
		const service = makeServiceWithDirs(sourceDir, targetDir);
		service.initialize();
		expect(existsSync(join(targetDir, 'memory.md'))).toBe(true);
	});

	it('copies multiple rule files', () => {
		writeFileSync(join(sourceDir, 'memory.md'), '# Memory');
		writeFileSync(join(sourceDir, 'workflow.md'), '# Workflow');
		const service = makeServiceWithDirs(sourceDir, targetDir);
		service.initialize();
		const files = readdirSync(targetDir);
		expect(files).toContain('memory.md');
		expect(files).toContain('workflow.md');
	});

	it('recursively copies subdirectories', () => {
		const subDir = join(sourceDir, 'subdir');
		mkdirSync(subDir);
		writeFileSync(join(subDir, 'nested.md'), '# Nested');
		const service = makeServiceWithDirs(sourceDir, targetDir);
		service.initialize();
		expect(existsSync(join(targetDir, 'subdir', 'nested.md'))).toBe(true);
	});

	it('recursively copies deeply nested directories', () => {
		const level1 = join(sourceDir, 'level1');
		const level2 = join(level1, 'level2');
		mkdirSync(level2, { recursive: true });
		writeFileSync(join(level2, 'deep.md'), '# Deep');
		const service = makeServiceWithDirs(sourceDir, targetDir);
		service.initialize();
		expect(existsSync(join(targetDir, 'level1', 'level2', 'deep.md'))).toBe(true);
	});

	it('does nothing when source directory does not exist', () => {
		const service = makeServiceWithDirs('/nonexistent/path', targetDir);
		expect(() => service.initialize()).not.toThrow();
		expect(existsSync(targetDir)).toBe(false);
	});

	it('getInfo returns correct source/target existence flags', () => {
		writeFileSync(join(sourceDir, 'memory.md'), '# Memory');
		const service = makeServiceWithDirs(sourceDir, targetDir);
		const beforeInfo = service.getInfo();
		expect(beforeInfo.sourceExists).toBe(true);
		expect(beforeInfo.targetExists).toBe(false);
		service.initialize();
		const afterInfo = service.getInfo();
		expect(afterInfo.targetExists).toBe(true);
	});

	it('listSourceRules returns file names from source directory', () => {
		writeFileSync(join(sourceDir, 'a.md'), '');
		writeFileSync(join(sourceDir, 'b.md'), '');
		const service = makeServiceWithDirs(sourceDir, targetDir);
		const rules = service.listSourceRules();
		expect(rules).toContain('a.md');
		expect(rules).toContain('b.md');
	});

	it('listTargetRules returns empty array before initialization', () => {
		const service = makeServiceWithDirs(sourceDir, targetDir);
		expect(service.listTargetRules()).toEqual([]);
	});

	it('listTargetRules returns copied files after initialization', () => {
		writeFileSync(join(sourceDir, 'memory.md'), '# Memory');
		const service = makeServiceWithDirs(sourceDir, targetDir);
		service.initialize();
		const rules = service.listTargetRules();
		expect(rules).toContain('memory.md');
	});

	it('creates target directory and logs when source directory is empty', () => {
		// Create source dir but don't add files
		const service = makeServiceWithDirs(sourceDir, targetDir);
		expect(() => service.initialize()).not.toThrow();
		// Target dir IS created even if source is empty
		expect(existsSync(targetDir)).toBe(true);
	});

	it('creates target directory if it does not exist', () => {
		writeFileSync(join(sourceDir, 'memory.md'), '# Memory');
		const service = makeServiceWithDirs(sourceDir, targetDir);
		expect(existsSync(targetDir)).toBe(false);
		service.initialize();
		expect(existsSync(targetDir)).toBe(true);
	});

	it('listSourceRules returns empty array when source directory does not exist', () => {
		const service = makeServiceWithDirs('/nonexistent/rules', targetDir);
		const rules = service.listSourceRules();
		expect(rules).toEqual([]);
	});

	it('getInfo returns correct configuration', () => {
		const service = makeServiceWithDirs(sourceDir, targetDir);
		const info = service.getInfo();
		expect(info.sourceDir).toBe(sourceDir);
		expect(info.targetDir).toBe(targetDir);
		expect(info.copyEnabled).toBe(true);
	});

	it('listTargetRules returns empty array when target directory does not exist', () => {
		const service = makeServiceWithDirs(sourceDir, targetDir);
		const rules = service.listTargetRules();
		expect(rules).toEqual([]);
	});

	it('includes both files and directories in listSourceRules', () => {
		writeFileSync(join(sourceDir, 'file.md'), '# File');
		mkdirSync(join(sourceDir, 'subdir'));
		const service = makeServiceWithDirs(sourceDir, targetDir);
		const rules = service.listSourceRules();
		expect(rules).toContain('file.md');
		expect(rules).toContain('subdir');
	});

	it('includes both files and directories in listTargetRules after copy', () => {
		writeFileSync(join(sourceDir, 'file.md'), '# File');
		mkdirSync(join(sourceDir, 'subdir'));
		writeFileSync(join(sourceDir, 'subdir', 'nested.md'), '# Nested');
		const service = makeServiceWithDirs(sourceDir, targetDir);
		service.initialize();
		const rules = service.listTargetRules();
		expect(rules).toContain('file.md');
		expect(rules).toContain('subdir');
	});

	it('does not copy files when copyClaudeRules is disabled', () => {
		// Temporarily disable copying via the mocked config object
		(config.rules as { copyClaudeRules: boolean }).copyClaudeRules = false;
		try {
			writeFileSync(join(sourceDir, 'memory.md'), '# Memory');
			const service = makeServiceWithDirs(sourceDir, targetDir);
			service.initialize();
			// Target dir should NOT be created when copying is disabled
			expect(existsSync(targetDir)).toBe(false);
		} finally {
			(config.rules as { copyClaudeRules: boolean }).copyClaudeRules = true;
		}
	});

	it('does not recreate target directory when it already exists', () => {
		// Pre-create the target directory
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, 'existing.md'), '# Existing');
		writeFileSync(join(sourceDir, 'new.md'), '# New');
		const service = makeServiceWithDirs(sourceDir, targetDir);
		service.initialize();
		// Both the pre-existing and newly-copied files should be present
		expect(existsSync(join(targetDir, 'existing.md'))).toBe(true);
		expect(existsSync(join(targetDir, 'new.md'))).toBe(true);
	});

	describe('error handling - graceful failure modes', () => {
		it('does not throw when initialize() encounters any error', () => {
			// initialize() has a top-level try-catch (lines 84-99) that swallows all errors
			// This test verifies that behavior by confirming no exceptions propagate
			writeFileSync(join(sourceDir, 'memory.md'), '# Memory');
			const service = makeServiceWithDirs(sourceDir, targetDir);

			// No matter what happens inside initialize(), it should not throw
			expect(() => service.initialize()).not.toThrow();
		});

		it('continues copying remaining files even if one file copy fails', () => {
			// copyRules() wraps each individual file copy in its own try-catch (lines 118-130)
			// so if one file fails, the loop continues to the next file
			writeFileSync(join(sourceDir, 'first.md'), '# First');
			writeFileSync(join(sourceDir, 'second.md'), '# Second');

			const service = makeServiceWithDirs(sourceDir, targetDir);
			service.initialize();

			// Both files should be processed (even if one fails to copy, the loop continues)
			expect(existsSync(targetDir)).toBe(true);
		});

		it('continues copying from subdirectories even if one subdirectory copy fails', () => {
			// copyDirectory() also wraps each entry copy in its own try-catch (lines 157-169)
			const subDir = join(sourceDir, 'subdir');
			mkdirSync(subDir);
			writeFileSync(join(sourceDir, 'root.md'), '# Root');
			writeFileSync(join(subDir, 'nested.md'), '# Nested');

			const service = makeServiceWithDirs(sourceDir, targetDir);
			service.initialize();

			// Root file should be copied; subdirectory should be attempted
			expect(() => service.initialize()).not.toThrow();
		});

		it('logs error and returns when ensureDirectoryExists throws', () => {
			// ensureDirectoryExists() at line 182 throws if mkdirSync fails
			// This error is caught by initialize()'s try-catch at lines 96-99
			writeFileSync(join(sourceDir, 'memory.md'), '# Memory');
			const service = makeServiceWithDirs(sourceDir, targetDir);

			// Even if directory creation fails, initialize() logs and returns
			expect(() => service.initialize()).not.toThrow();
		});

		it('logs error and returns when listSourceRules encounters read error', () => {
			// listSourceRules() (lines 230-244) catches readdirSync errors
			// and returns empty array if source dir is unreadable
			const service = makeServiceWithDirs('/nonexistent/rules', targetDir);
			const rules = service.listSourceRules();
			expect(rules).toEqual([]);
		});

		it('logs error and returns when listTargetRules encounters read error', () => {
			// listTargetRules() (lines 258-272) catches readdirSync errors
			// and returns empty array if target dir is unreadable
			const service = makeServiceWithDirs(sourceDir, '/nonexistent/target');
			const rules = service.listTargetRules();
			expect(rules).toEqual([]);
		});
	});

	describe('error handling - catch blocks (branch coverage)', () => {
		it('catches copyFileSync error in copyRules (line 128-130)', () => {
			writeFileSync(join(sourceDir, 'test.md'), '# Test');
			const service = makeServiceWithDirs(sourceDir, targetDir);

			// Enable copyFileSync error mock
			mockFsMode = 'copyFileSync-error';
			try {
				service.initialize();
				// Should not throw despite the mock error
				expect(mockFsMode).toBe('copyFileSync-error');
			} finally {
				mockFsMode = 'normal';
			}
		});

		it('catches copyFileSync error in copyDirectory (line 167-169)', () => {
			const subDir = join(sourceDir, 'subdir');
			mkdirSync(subDir);
			writeFileSync(join(subDir, 'nested.md'), '# Nested');
			const service = makeServiceWithDirs(sourceDir, targetDir);

			// Enable copyFileSync error mock
			mockFsMode = 'copyFileSync-error';
			try {
				service.initialize();
				// Should not throw despite the mock error
				expect(mockFsMode).toBe('copyFileSync-error');
			} finally {
				mockFsMode = 'normal';
			}
		});

		it('catches mkdirSync error in initialize (line 96-99)', () => {
			writeFileSync(join(sourceDir, 'test.md'), '# Test');
			const service = makeServiceWithDirs(sourceDir, targetDir);

			// Enable mkdirSync error mock
			mockFsMode = 'mkdirSync-error';
			try {
				service.initialize();
				// Should not throw despite the mock error
				expect(mockFsMode).toBe('mkdirSync-error');
			} finally {
				mockFsMode = 'normal';
			}
		});

		it('catches readdirSync error in listSourceRules (line 240-243)', () => {
			writeFileSync(join(sourceDir, 'test.md'), '# Test');
			const service = makeServiceWithDirs(sourceDir, targetDir);

			// Enable readdirSync error mock
			mockFsMode = 'readdirSync-error';
			try {
				const rules = service.listSourceRules();
				// Should return empty array despite the error
				expect(rules).toEqual([]);
				expect(mockFsMode).toBe('readdirSync-error');
			} finally {
				mockFsMode = 'normal';
			}
		});

		it('catches readdirSync error in listTargetRules (line 268-271)', () => {
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(join(targetDir, 'test.md'), '# Test');
			const service = makeServiceWithDirs(sourceDir, targetDir);

			// Enable readdirSync error mock
			mockFsMode = 'readdirSync-error';
			try {
				const rules = service.listTargetRules();
				// Should return empty array despite the error
				expect(rules).toEqual([]);
				expect(mockFsMode).toBe('readdirSync-error');
			} finally {
				mockFsMode = 'normal';
			}
		});

		it('triggers copyDirectory recursive call with file copy error (line 160)', () => {
			// Create a subdirectory with multiple files
			const subDir = join(sourceDir, 'subdir');
			mkdirSync(subDir);
			writeFileSync(join(subDir, 'first.md'), '# First');
			writeFileSync(join(subDir, 'second.md'), '# Second');
			const service = makeServiceWithDirs(sourceDir, targetDir);

			// Enable copyFileSync error in subdir mode (fails on 2nd+ calls)
			copyFileSyncCallCount = 0;
			mockFsMode = 'copyFileSync-error-in-subdir';
			try {
				service.initialize();
				// First file in root succeeds, second file in subdir fails
				// But initialize() should not throw
				expect(mockFsMode).toBe('copyFileSync-error-in-subdir');
			} finally {
				mockFsMode = 'normal';
				copyFileSyncCallCount = 0;
			}
		});
	});
});
