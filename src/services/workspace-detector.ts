/**
 * Workspace Detector Service
 *
 * Auto-detect workspace from package.json or directory name
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Workspace detection result
 *
 * @example
 * ```typescript
 * const result: WorkspaceDetectionResult = {
 *   workspace: 'mcp-memory',
 *   source: 'package.json',
 *   path: '/workspace/mcp-memory/package.json',
 * };
 * ```
 */
export interface WorkspaceDetectionResult {
	workspace: string | null;
	source: 'explicit' | 'package.json' | 'directory' | 'default' | 'none';
	path?: string;
}

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
 *
 * @example
 * ```typescript
 * const service = new WorkspaceDetectorService();
 * const result = service.detect();
 * console.log(result.workspace); // 'mcp-memory' or null
 * console.log(result.source);    // 'package.json' or 'directory'
 * ```
 */
export class WorkspaceDetectorService {
	// Mutable: cache entries updated on workspace detection
	private cachedWorkspace: string | null = null;
	private cachedSource: WorkspaceDetectionResult['source'] = 'none';
	private cacheTimestamp: number = 0;
	private cachePopulated: boolean = false;

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
   * @example
   * ```typescript
   * const detector = new WorkspaceDetectorService();
   * const result = detector.detect();
   * // result.workspace may be 'my-project' (from package.json) or null
   * const explicit = detector.detect('my-workspace');
   * // explicit.workspace === 'my-workspace', explicit.source === 'explicit'
   * ```
   */
	public detect(
		explicitWorkspace?: string | null,
		currentDir: string = process.cwd(),
	): WorkspaceDetectionResult {
		// 1. Explicit workspace (highest priority)
		if (explicitWorkspace !== undefined) {
			if (explicitWorkspace === null) {
				this.updateCache(null, 'explicit');
				return { workspace: null, source: 'explicit' };
			}
			if (this.isValidWorkspace(explicitWorkspace)) {
				logger.debug(`Using explicit workspace: ${explicitWorkspace}`);
				this.updateCache(explicitWorkspace, 'explicit');
				return { workspace: explicitWorkspace, source: 'explicit' };
			}
			// Invalid explicit workspace: fall through to auto-detection
			logger.warn('Workspace validation failed, falling through to auto-detection');
		}

		// 2. Check cache (only valid when autoDetect is still enabled)
		if (
			config.workspace.autoDetect &&
      this.cachePopulated &&
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
		this.updateCache(defaultWorkspace, defaultWorkspace ? 'default' : 'none');
		return {
			workspace: defaultWorkspace,
			source: defaultWorkspace ? 'default' : 'none',
		};
	}

	/**
	 * Type guard for package.json with name string.
	 *
	 * @param value - The value to check
	 * @returns True if value is an object with name property that's a string
	 * @example
	 * ```typescript
	 * const data = JSON.parse(content);
	 * if (isPackageJsonWithName(data)) {
	 *   console.log(data.name); // TypeScript knows this is string
	 * }
	 * ```
	 */
	private isPackageJsonWithName(value: unknown): value is { name: string } {
		return (
			typeof value === 'object' &&
			value !== null &&
			'name' in value &&
			typeof (value as Record<string, unknown>).name === 'string'
		);
	}

	/**
   * Walk up the directory tree looking for a `package.json` with a `name` field.
   *
   * Traverses up to `maxLevels` parent directories. Returns immediately on
   * first successful read with a valid package name. Stops if `package.json`
   * cannot be parsed or if the `name` field is empty.
   *
   * @param startDir - Directory to begin the search.
   * @param maxLevels - Maximum number of parent directories to traverse (default 5).
   * @returns WorkspaceDetectionResult | null - A detection result derived from the package name, or `null` if
   *   no suitable `package.json` was found within the traversal limit.
   * @throws Does not throw; parse errors are logged and traversal continues.
   * @example
   * ```typescript
   * const result = detector.findPackageJson(process.cwd(), 5);
   * if (result) {
   *   console.log(result.workspace); // Workspace name from package.json
   * }
   * ```
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
					const packageJson: unknown = JSON.parse(
						readFileSync(packageJsonPath, 'utf-8'),
					);

					if (this.isPackageJsonWithName(packageJson)) {
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
   * @returns `true` if the name is a valid workspace slug, `false` otherwise.
   * @example
   * ```typescript
   * detector.isValidWorkspace('my-project');   // true
   * detector.isValidWorkspace('system');        // false (reserved)
   * detector.isValidWorkspace('@scope/name');   // false (invalid characters)
   * detector.isValidWorkspace('');              // false (empty)
   * ```
   */
	public isValidWorkspace(name: string): boolean {
		if (!name) {
			return false;
		}

		if (name.length > MAX_WORKSPACE_NAME_LENGTH) {
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
   * @returns string - The cleaned name (may still fail {@link isValidWorkspace} if empty after cleaning).
   * @example
   * ```typescript
   * const clean1 = cleanWorkspaceName('@scope/my-app');    // 'my-app'
   * const clean2 = cleanWorkspaceName('mcp-memory');       // 'memory'
   * const clean3 = cleanWorkspaceName('My_App@123');       // 'My_App-123'
   * ```
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
   * @param source - The detection source to report on cache hits (default `'package.json'`).
   * @example
   * ```typescript
   * detector.updateCache('my-project', 'package.json');
   * // Cache now stores 'my-project' and will be valid for WORKSPACE_CACHE_TTL ms
   * ```
   */
	private updateCache(workspace: string | null, source: WorkspaceDetectionResult['source'] = 'package.json'): void {
		this.cachedWorkspace = workspace;
		this.cachedSource = source;
		this.cacheTimestamp = Date.now();
		this.cachePopulated = true;
	}

	/**
   * Invalidate the in-memory workspace cache.
   * The next call to {@link detect} will perform a fresh auto-detection.
   *
   * @example
   * ```typescript
   * detector.clearCache();
   * // Next call to detect() will re-read package.json / directory
   * const fresh = detector.detect();
   * ```
   */
	public clearCache(): void {
		this.cachedWorkspace = null;
		this.cachedSource = 'none';
		this.cacheTimestamp = 0;
		this.cachePopulated = false;
		logger.debug('Workspace cache cleared');
	}

	/**
	 * Return the cached workspace if the TTL has not expired, otherwise `null`.
	 *
	 * Differentiates between cache miss/expiration and never-detected state to support
	 * better diagnostics.
	 *
	 * @returns Object with `workspace` (cached value or null) and `cached` (true if cache was valid).
	 * @example
	 * ```typescript
	 * const result = detector.getCached();
	 * if (result.cached) {
	 *   console.log('Using cached workspace:', result.workspace);
	 * } else if (result.workspace === null) {
	 *   console.log('Cache never populated');
	 * } else {
	 *   console.log('Cache expired, last value was:', result.workspace);
	 * }
	 * ```
	 */
	public getCached(): { workspace: string | null, cached: boolean } {
		if (!this.cachePopulated) {
			return { workspace: null, cached: false };
		}
		const isExpired = Date.now() - this.cacheTimestamp >= this.CACHE_TTL;
		if (!isExpired) {
			return { workspace: this.cachedWorkspace, cached: true };
		}
		return { workspace: this.cachedWorkspace, cached: false };
	}

	/**
   * Normalise a workspace name to lowercase for case-insensitive comparison.
   *
   * @param workspace - Workspace name, or `null`.
   * @returns Lowercase trimmed name, or `null` if the input was `null`.
   * @example
   * ```typescript
   * detector.normalize('MyProject');  // 'myproject'
   * detector.normalize(null);         // null
   * ```
   */
	public normalize(workspace: string | null): string | null {
		if (workspace === null) {
			return null;
		}

		return workspace.toLowerCase().trim();
	}

	/**
   * Compare two workspace names for equality, ignoring case.
   *
   * @param a - First workspace name or `null`.
   * @param b - Second workspace name or `null`.
   * @returns `true` when both names normalise to the same string.
   * @example
   * ```typescript
   * detector.equals('MyProject', 'myproject'); // true
   * detector.equals('ProjectA', 'ProjectB');   // false
   * detector.equals(null, null);               // true
   * ```
   */
	public equals(a: string | null, b: string | null): boolean {
		return this.normalize(a) === this.normalize(b);
	}

	/**
   * Return a diagnostic snapshot of the current detection state.
   * Useful for debugging workspace resolution in complex monorepos.
   *
   * @param currentDir - Directory to run detection from (defaults to `process.cwd()`).
   * @returns Snapshot object with `detected` (current workspace result), `config` (auto-detect
   *   settings), and `cache` (current cache age and validity).
   * @remarks This method calls `detect()` internally, which may update the workspace cache on first call.
   * @example
   * ```typescript
   * const info = detector.getInfo();
   * console.log('Workspace:', info.detected.workspace);
   * console.log('Cache age (ms):', info.cache.age);
   * console.log('Cache valid:', info.cache.valid);
   * ```
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

/**
 * Singleton {@link WorkspaceDetectorService} instance used throughout the application.
 *
 * @example
 * ```typescript
 * import { workspaceDetector } from './services/workspace-detector.js';
 * const result = workspaceDetector.detect();
 * console.log(result.workspace); // 'mcp-memory' or null
 * console.log(result.source);    // 'package.json', 'directory', etc.
 * ```
 */
export const workspaceDetector = new WorkspaceDetectorService();
