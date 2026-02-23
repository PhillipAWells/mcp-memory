/**
 * Workspace Detector Service
 *
 * Auto-detect workspace from package.json or directory name
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Workspace detection result
 */
export interface WorkspaceDetectionResult {
	workspace: string | null;
	source: 'explicit' | 'package.json' | 'directory' | 'default' | 'none';
	path?: string;
}

/**
 * Detects the current workspace name from environmental context.
 *
 * Detection follows this priority chain (highest → lowest):
 * 1. Explicit workspace string passed to {@link detect}
 * 2. In-memory TTL cache from the previous successful detection
 * 3. `name` field in the nearest `package.json` (searches up to 5 parent dirs)
 * 4. Current directory basename
 * 5. `WORKSPACE_DEFAULT` environment variable
 * 6. `null` (no workspace)
 *
 * Workspace names must match `[a-zA-Z0-9_-]+` (max 100 characters).
 * Scoped npm package names like `@scope/name` are normalised to `name`.
 */
/** Maximum allowed workspace name length. */
const MAX_WORKSPACE_NAME_LENGTH = 100;
/** Number of parent directories to search for package.json. */
const PACKAGE_JSON_SEARCH_LEVELS = 5;
/**
 * Names reserved for internal use.  Storing memories under these names could
 * cause confusion in logs and error messages, so they are rejected at validation time.
 */
const RESERVED_WORKSPACE_NAMES = new Set([
	'system', 'metadata', 'admin', 'internal', 'default', 'null', 'undefined', 'root',
]);

export class WorkspaceDetectorService {
	private cachedWorkspace: string | null = null;
	private cachedSource: WorkspaceDetectionResult['source'] = 'none';
	private cacheTimestamp: number = 0;

	// Workspace name pattern (alphanumeric, underscore, hyphen)
	private readonly WORKSPACE_PATTERN = /^[a-zA-Z0-9_-]+$/;

	// Get cache TTL from config
	private get CACHE_TTL(): number {
		return config.workspace.cacheTTL;
	}

	/**
   * Detect the workspace for the current invocation context.
   *
   * @param explicitWorkspace - If provided and valid, returned immediately as
   *   `source: 'explicit'`.  Pass `null` to explicitly clear the workspace.
   * @param currentDir - Directory to start the `package.json` search from
   *   (defaults to `process.cwd()`).
   * @returns The detected workspace name and the source that produced it.
   */
	public detect(
		explicitWorkspace?: string | null,
		currentDir: string = process.cwd(),
	): WorkspaceDetectionResult {
		// 1. Explicit workspace (highest priority)
		if (explicitWorkspace !== undefined) {
			if (explicitWorkspace === null) {
				return { workspace: null, source: 'explicit' };
			}
			if (this.isValidWorkspace(explicitWorkspace)) {
				logger.debug(`Using explicit workspace: ${explicitWorkspace}`);
				return { workspace: explicitWorkspace, source: 'explicit' };
			}
			logger.warn(`Invalid explicit workspace: ${explicitWorkspace}`);
		}

		// 2. Check cache (only valid when autoDetect is still enabled)
		if (
			config.workspace.autoDetect &&
      this.cachedWorkspace !== null &&
      Date.now() - this.cacheTimestamp < this.CACHE_TTL
		) {
			logger.debug(`Using cached workspace: ${this.cachedWorkspace}`);
			return {
				workspace: this.cachedWorkspace,
				source: this.cachedSource,
			};
		}

		// 3. Auto-detection disabled
		if (!config.workspace.autoDetect) {
			const defaultWorkspace = config.workspace.default ?? null;
			logger.debug(
				`Auto-detection disabled, using default: ${defaultWorkspace}`,
			);
			return {
				workspace: defaultWorkspace,
				source: 'default',
			};
		}

		// 4. Try package.json (search up to 5 parent directories)
		const packageJsonResult = this.findPackageJson(currentDir);
		if (packageJsonResult) {
			this.updateCache(packageJsonResult.workspace, packageJsonResult.source);
			return packageJsonResult;
		}

		// 5. Fall back to directory name
		const dirName = basename(currentDir);
		if (this.isValidWorkspace(dirName)) {
			const dirResult: WorkspaceDetectionResult = {
				workspace: dirName,
				source: 'directory',
				path: currentDir,
			};
			this.updateCache(dirName, 'directory');
			logger.debug(`Using directory name as workspace: ${dirName}`);
			return dirResult;
		}

		// 6. Fall back to configured default
		const defaultWorkspace = config.workspace.default ?? null;
		logger.debug(`Using default workspace: ${defaultWorkspace}`);
		return {
			workspace: defaultWorkspace,
			source: defaultWorkspace ? 'default' : 'none',
		};
	}

	/**
   * Walk up the directory tree looking for a `package.json` with a `name` field.
   *
   * @param startDir - Directory to begin the search.
   * @param maxLevels - Maximum number of parent directories to traverse (default 5).
   * @returns A detection result derived from the package name, or `null` if
   *   no suitable `package.json` was found within the traversal limit.
   */
	private findPackageJson(
		startDir: string,
		maxLevels: number = PACKAGE_JSON_SEARCH_LEVELS,
	): WorkspaceDetectionResult | null {
		let currentDir = startDir;

		for (let level = 0; level < maxLevels; level++) {
			const packageJsonPath = join(currentDir, 'package.json');

			if (existsSync(packageJsonPath)) {
				try {
					const packageJson = JSON.parse(
						readFileSync(packageJsonPath, 'utf-8'),
					);

					if (packageJson.name && typeof packageJson.name === 'string') {
						// Extract workspace name from package name
						// Handle scoped packages: @scope/name -> scope-name or just name
						let workspaceName = packageJson.name;

						if (workspaceName.startsWith('@')) {
							// @scope/name -> name (simple approach)
							workspaceName = workspaceName.split('/').pop() ?? workspaceName;
						}

						// Clean and validate
						workspaceName = this.cleanWorkspaceName(workspaceName);

						if (this.isValidWorkspace(workspaceName)) {
							logger.debug(
								`Found workspace in package.json: ${workspaceName} (${packageJsonPath})`,
							);
							return {
								workspace: workspaceName,
								source: 'package.json',
								path: packageJsonPath,
							};
						} else {
							logger.debug(
								`Invalid workspace name in package.json: ${workspaceName}`,
							);
						}
					}
				} catch (error) {
					logger.warn(`Failed to parse package.json at ${packageJsonPath}:`, error);
				}
			}

			// Move to parent directory
			const parentDir = dirname(currentDir);
			if (parentDir === currentDir) {
				// Reached root
				break;
			}
			currentDir = parentDir;
		}

		return null;
	}

	/**
   * Return `true` when `name` satisfies the workspace name constraints:
   * non-empty string, 1–100 characters, matching `[a-zA-Z0-9_-]+`, and
   * not a reserved internal name.
   *
   * @param name - Candidate workspace name.
   */
	public isValidWorkspace(name: string): boolean {
		if (!name || typeof name !== 'string') {
			return false;
		}

		if (name.length === 0 || name.length > MAX_WORKSPACE_NAME_LENGTH) {
			return false;
		}

		if (!this.WORKSPACE_PATTERN.test(name)) {
			return false;
		}

		// Reject reserved names that could cause confusion in logs/errors
		if (RESERVED_WORKSPACE_NAMES.has(name.toLowerCase())) {
			logger.warn(`Workspace name "${name}" is reserved and cannot be used`);
			return false;
		}

		return true;
	}

	/**
   * Normalise a raw package name into a valid workspace slug:
   * removes leading `mcp-` / `@scope/` prefixes, replaces invalid characters
   * with hyphens, and collapses repeated hyphens.
   *
   * @param name - Raw name string to clean.
   * @returns The cleaned name (may still fail {@link isValidWorkspace} if empty after cleaning).
   */
	private cleanWorkspaceName(name: string): string {
		return name
			.replace(/^(mcp-|@[^/]+\/)/g, '')
			.replace(/[^a-zA-Z0-9_-]/g, '-')
			.replace(/^-+|-+$/g, '')
			.replace(/-+/g, '-');
	}

	/**
   * Store `workspace` in the in-memory cache and reset the TTL timer.
   *
   * @param workspace - Resolved workspace name, or `null` when none was found.
   * @param source    - The detection source to report on cache hits.
   */
	private updateCache(workspace: string | null, source: WorkspaceDetectionResult['source'] = 'package.json'): void {
		this.cachedWorkspace = workspace;
		this.cachedSource = source;
		this.cacheTimestamp = Date.now();
	}

	/**
   * Invalidate the in-memory workspace cache.
   * The next call to {@link detect} will perform a fresh auto-detection.
   */
	public clearCache(): void {
		this.cachedWorkspace = null;
		this.cachedSource = 'none';
		this.cacheTimestamp = 0;
		logger.debug('Workspace cache cleared');
	}

	/**
   * Return the cached workspace if the TTL has not expired, otherwise `null`.
   */
	public getCached(): string | null {
		if (Date.now() - this.cacheTimestamp < this.CACHE_TTL) {
			return this.cachedWorkspace;
		}
		return null;
	}

	/**
   * Normalise a workspace name to lowercase for case-insensitive comparison.
   *
   * @param workspace - Workspace name, or `null`.
   * @returns Lowercase trimmed name, or `null` if the input was `null`/`undefined`.
   */
	public normalize(workspace: string | null): string | null {
		if (workspace === null || workspace === undefined) {
			return null;
		}

		return workspace.toLowerCase();
	}

	/**
   * Compare two workspace names for equality, ignoring case.
   *
   * @returns `true` when both names normalise to the same string.
   */
	public equals(a: string | null, b: string | null): boolean {
		return this.normalize(a) === this.normalize(b);
	}

	/**
   * Return a diagnostic snapshot of the current detection state.
   * Useful for debugging workspace resolution in complex monorepos.
   *
   * @param currentDir - Directory to run detection from (defaults to `process.cwd()`).
   */
	public getInfo(currentDir: string = process.cwd()): {
		detected: WorkspaceDetectionResult;
		config: {
			autoDetect: boolean;
			default: string | null;
		};
		cache: {
			workspace: string | null;
			age: number;
			valid: boolean;
		};
	} {
		const detected = this.detect(undefined, currentDir);
		const cacheAge = Date.now() - this.cacheTimestamp;

		return {
			detected,
			config: {
				autoDetect: config.workspace.autoDetect,
				default: config.workspace.default,
			},
			cache: {
				workspace: this.cachedWorkspace,
				age: cacheAge,
				valid: cacheAge < this.CACHE_TTL,
			},
		};
	}
}

/** Singleton {@link WorkspaceDetectorService} instance used throughout the application. */
export const workspaceDetector = new WorkspaceDetectorService();
