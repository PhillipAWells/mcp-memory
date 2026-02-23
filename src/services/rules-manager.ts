/**
 * Rules Manager Service
 *
 * Manages copying of rules to Claude's rules directory
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Copies rule files from the package's `rules/` directory into the user's
 * `.claude/rules/` directory at server startup.
 *
 * This makes Claude Code aware of project-specific memory usage guidelines
 * without requiring manual installation steps.  The copy runs once on
 * {@link initialize} and is non-blocking — errors are logged as warnings
 * rather than crashing the server.
 *
 * Controlled by the `COPY_CLAUDE_RULES` environment variable (default `true`).
 */
export class RulesManagerService {
	private readonly sourceDir: string;
	private readonly targetDir: string;

	/**
   * Resolves the source directory (package `rules/`) and the target directory
   * (`.claude/rules/` relative to `process.cwd()`) from the module's location.
   */
	constructor() {
		// Get the directory where this module is located
		const currentFileUrl = import.meta.url;
		const currentFilePath = fileURLToPath(currentFileUrl);
		const currentDir = dirname(currentFilePath);

		// Source: rules/ directory in the package root
		// Navigate up from src/services/ to package root
		this.sourceDir = join(currentDir, '..', '..', 'rules');

		// Target: .claude/rules/ in the current working directory
		this.targetDir = join(process.cwd(), '.claude', 'rules');

		logger.debug(`Rules source directory: ${this.sourceDir}`);
		logger.debug(`Rules target directory: ${this.targetDir}`);
	}

	/**
   * Initialize rules - copy to Claude directory if enabled
   */
	public async initialize(): Promise<void> {
		if (!config.rules.copyClaudeRules) {
			logger.info('Rule copying disabled (COPY_CLAUDE_RULES=false)');
			return;
		}

		logger.info('Initializing rules...');

		// Check if source directory exists
		if (!existsSync(this.sourceDir)) {
			logger.warn(`Rules source directory does not exist: ${this.sourceDir}`);
			return;
		}

		try {
			// Ensure target directory exists
			this.ensureDirectoryExists(this.targetDir);

			// Copy rules
			const copiedCount = await this.copyRules();

			if (copiedCount > 0) {
				logger.info(`Copied ${copiedCount} rule file(s) to ${this.targetDir}`);
			} else {
				logger.info('No rules to copy (source directory is empty)');
			}
		} catch (error) {
			logger.error('Failed to initialize rules:', error);
			// Don't throw - rules copying is not critical for server operation
		}
	}

	/**
   * Copy every file and subdirectory from {@link sourceDir} to {@link targetDir}.
   *
   * @returns The total number of files successfully copied.
   */
	private async copyRules(): Promise<number> {
		let copiedCount = 0;

		// Read source directory
		const entries = readdirSync(this.sourceDir, { withFileTypes: true });

		for (const entry of entries) {
			const sourcePath = join(this.sourceDir, entry.name);
			const targetPath = join(this.targetDir, entry.name);

			try {
				if (entry.isDirectory()) {
					// Recursively copy subdirectory (for future nested rule organization)
					copiedCount += await this.copyDirectory(sourcePath, targetPath);
				} else if (entry.isFile()) {
					// Copy file
					copyFileSync(sourcePath, targetPath);
					logger.debug(`Copied rule: ${entry.name}`);
					copiedCount++;
				}
			} catch (error) {
				logger.warn(`Failed to copy ${entry.name}:`, error);
			}
		}

		return copiedCount;
	}

	/**
   * Recursively copy all entries from `source` into `target`.
   *
   * @param source - Absolute path to the source directory.
   * @param target - Absolute path to the destination directory (created if absent).
   * @returns The number of files copied in this subtree.
   */
	private async copyDirectory(source: string, target: string): Promise<number> {
		let copiedCount = 0;

		// Ensure target directory exists
		this.ensureDirectoryExists(target);

		// Read source directory
		const entries = readdirSync(source, { withFileTypes: true });

		for (const entry of entries) {
			const sourcePath = join(source, entry.name);
			const targetPath = join(target, entry.name);

			try {
				if (entry.isDirectory()) {
					// Recursively copy subdirectory
					copiedCount += await this.copyDirectory(sourcePath, targetPath);
				} else if (entry.isFile()) {
					// Copy file
					copyFileSync(sourcePath, targetPath);
					logger.debug(`Copied rule: ${entry.name}`);
					copiedCount++;
				}
			} catch (error) {
				logger.warn(`Failed to copy ${entry.name}:`, error);
			}
		}

		return copiedCount;
	}

	/**
   * Create `dirPath` and any missing parent directories if it does not exist.
   *
   * @param dirPath - Absolute path of the directory to ensure.
   */
	private ensureDirectoryExists(dirPath: string): void {
		if (!existsSync(dirPath)) {
			mkdirSync(dirPath, { recursive: true });
			logger.debug(`Created directory: ${dirPath}`);
		}
	}

	/**
   * Return a summary of the rules manager configuration and directory state.
   * Useful for diagnostics and the `memory-status` tool.
   */
	public getInfo(): {
		sourceDir: string;
		targetDir: string;
		sourceExists: boolean;
		targetExists: boolean;
		copyEnabled: boolean;
	} {
		return {
			sourceDir: this.sourceDir,
			targetDir: this.targetDir,
			sourceExists: existsSync(this.sourceDir),
			targetExists: existsSync(this.targetDir),
			copyEnabled: config.rules.copyClaudeRules,
		};
	}

	/**
   * Return the names of all files and directories in the source `rules/` directory.
   * Returns an empty array if the source directory does not exist.
   */
	public listSourceRules(): string[] {
		if (!existsSync(this.sourceDir)) {
			return [];
		}

		try {
			return readdirSync(this.sourceDir).filter((name) => {
				const fullPath = join(this.sourceDir, name);
				const stat = statSync(fullPath);
				return stat.isFile() || stat.isDirectory();
			});
		} catch (error) {
			logger.error('Failed to list source rules:', error);
			return [];
		}
	}

	/**
   * Return the names of all files and directories in the target `.claude/rules/` directory.
   * Returns an empty array if the target directory does not yet exist.
   */
	public listTargetRules(): string[] {
		if (!existsSync(this.targetDir)) {
			return [];
		}

		try {
			return readdirSync(this.targetDir).filter((name) => {
				const fullPath = join(this.targetDir, name);
				const stat = statSync(fullPath);
				return stat.isFile() || stat.isDirectory();
			});
		} catch (error) {
			logger.error('Failed to list target rules:', error);
			return [];
		}
	}
}

/** Singleton {@link RulesManagerService} instance used during server startup. */
export const rulesManager = new RulesManagerService();
