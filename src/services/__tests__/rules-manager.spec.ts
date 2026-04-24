/**
 * Unit tests for RulesManagerService
 *
 * Uses a real temporary directory to test file-system operations.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Mock config ───────────────────────────────────────────────────────────────
vi.mock('../../config.js', () => ({
	config: {
		rules: { copyClaudeRules: true },
		server: { logLevel: 'silent' },
	},
}));

// We test RulesManagerService by subclassing/monkey-patching to inject temp dirs.
// The service resolves dirs from import.meta.url so we need a helper approach.

import { RulesManagerService } from '../rules-manager.js';

function makeServiceWithDirs(sourceDir: string, targetDir: string): RulesManagerService {
	const service = new RulesManagerService();
	// Override the private dirs via type cast to test with our temp dirs
	(service as any).sourceDir = sourceDir;
	(service as any).targetDir = targetDir;
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
});
