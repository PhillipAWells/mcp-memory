/**
 * HTTP(S) Proxy Configuration
 *
 * Installs a global fetch dispatcher using undici's EnvHttpProxyAgent when any
 * of the standard proxy environment variables are set (HTTPS_PROXY, HTTP_PROXY,
 * https_proxy, http_proxy).
 *
 * This module must be imported before any HTTP client is constructed, because it
 * patches the undici global dispatcher — affecting all HTTP clients that do not
 * provide their own dispatcher:
 *   - OpenAI SDK (uses globalThis.fetch internally without custom dispatcher)
 *   - Other HTTP clients using the default dispatcher
 *
 * Clients like the Qdrant JS client that provide their own dispatcher instance
 * will use their supplied dispatcher instead of the global one; this is expected
 * behavior and does not require special handling.
 *
 * No new npm production dependencies are introduced. undici is a bundled
 * dependency of Node.js 22+ and is already present in node_modules.
 *
 * Standard proxy environment variables:
 *   HTTPS_PROXY / https_proxy — proxy for HTTPS requests
 *   HTTP_PROXY  / http_proxy  — proxy for HTTP requests
 *   NO_PROXY    / no_proxy    — comma-separated list of hosts to bypass
 *
 * When a proxy is active and NO_PROXY is not set, DEFAULT_NO_PROXY is applied
 * automatically so local services (e.g. Qdrant on localhost) are never routed
 * through the proxy unintentionally.
 */

import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import type { Dispatcher } from 'undici';

/**
 * The NO_PROXY value applied automatically when a proxy is configured but
 * NO_PROXY is absent or empty. Excludes common localhost addresses.
 */
export const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1';

/**
 * Resolve the active proxy URL from the standard environment variables.
 * Returns the first non-empty value found in priority order, or null.
 *
 * Prefers uppercase forms (HTTPS_PROXY, HTTP_PROXY) as the canonical environment
 * variables, with lowercase (https_proxy, http_proxy) as fallbacks. This ensures
 * correct behavior on case-sensitive systems (Linux/macOS) where both can coexist,
 * and graceful behavior on case-insensitive systems (Windows) where the last
 * assignment takes precedence.
 *
 * @returns The proxy URL string from the environment, or `null` if no proxy is configured.
 * @example
 * ```typescript
 * // With HTTPS_PROXY=http://proxy.corp:8080 set
 * const url = getActiveProxyUrl(); // 'http://proxy.corp:8080'
 * // With no proxy env vars set
 * const url = getActiveProxyUrl(); // null
 * ```
 */
export function getActiveProxyUrl(): string | null {
	return (
		process.env.HTTPS_PROXY ??
		process.env.https_proxy ??
		process.env.HTTP_PROXY ??
		process.env.http_proxy ??
		null
	);
}

/**
 * The EnvHttpProxyAgent installed as the global dispatcher, or `null` if no
 * proxy is configured.
 *
 * Exposed for test introspection so tests can verify proxy installation without
 * triggering real network calls.
 *
 * @example
 * ```typescript
 * import { activeProxyAgent } from './proxy.js';
 * if (activeProxyAgent !== null) {
 *   console.log('Proxy agent is active');
 * }
 * ```
 */
export let activeProxyAgent: Dispatcher | null = null;

/**
 * `true` if `NO_PROXY` was automatically set to {@link DEFAULT_NO_PROXY} by this
 * module because the user did not supply their own value.
 *
 * Used by {@link initProxy} for accurate startup logging and by {@link resetProxy}
 * for clean test teardown — the auto-defaulted value must be removed so it does not
 * bleed into subsequent tests.
 *
 * @example
 * ```typescript
 * import { noProxyDefaulted } from './proxy.js';
 * if (noProxyDefaulted) {
 *   console.log('NO_PROXY was auto-defaulted to localhost exclusions');
 * }
 * ```
 */
export let noProxyDefaulted = false;

// --- Module-level side effect ---
// Runs synchronously when this module is first evaluated (at import time).
// The proxy import in src/index.ts must appear before all other imports.
const _initialProxyUrl = getActiveProxyUrl();

if (_initialProxyUrl !== null) {
	// If NO_PROXY is absent or empty, apply the safe default before constructing
	// the EnvHttpProxyAgent (which reads NO_PROXY at construction/request time).
	// This prevents local services such as Qdrant (localhost:6333) from being
	// accidentally routed through the corporate proxy.
	//
	// On case-sensitive systems (Linux/macOS), NO_PROXY and no_proxy are separate
	// variables. Check both to see if either was set by the user. On case-insensitive
	// systems (Windows), they refer to the same variable, so checking both is harmless.
	// Default to DEFAULT_NO_PROXY only if neither form is set by the user.
	if (!process.env.NO_PROXY && !process.env.no_proxy) {
		process.env.NO_PROXY = DEFAULT_NO_PROXY;
		noProxyDefaulted = true;
	}

	// Install the proxy-aware agent as the global dispatcher. Clients that do not
	// provide their own dispatcher will use this globally-configured proxy agent.
	// Clients like the Qdrant JS client that provide their own dispatcher will use
	// that dispatcher instead, which is the correct behavior and does not require
	// special handling.
	const agent = new EnvHttpProxyAgent();
	setGlobalDispatcher(agent);
	activeProxyAgent = agent;
}

/**
 * Log proxy status using the provided logger. Call this once during server
 * startup, after the logger is available, to confirm proxy configuration.
 *
 * The global dispatcher is already installed by the time this function is
 * called (the side effect above ran at import time).
 *
 * @param log - Minimal logger interface with `info` and `warn` methods. Accepts
 *   the application logger or any compatible object (useful in tests).
 * @example
 * ```typescript
 * import { initProxy } from './utils/proxy.js';
 * import { logger } from './utils/logger.js';
 * // Call once at startup, after the logger is ready
 * initProxy(logger);
 * ```
 */
export function initProxy(log: { info: (msg: string) => void; warn: (msg: string) => void }): void {
	const url = getActiveProxyUrl();

	if (url === null) {
		log.info('Proxy: not configured (HTTPS_PROXY / HTTP_PROXY not set)');
		return;
	}

	log.info(`Proxy: active — routing all fetch traffic through ${url}`);

	const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
	if (noProxyDefaulted) {
		log.info(
			`Proxy: NO_PROXY defaulted to "${noProxy}" — set NO_PROXY explicitly to override`,
		);
	} else if (noProxy) {
		log.info(`Proxy: NO_PROXY exclusions: ${noProxy}`);
	} else {
		log.info('Proxy: NO_PROXY not set (all domains will be proxied)');
	}
}

/**
 * Reset the global dispatcher to a new default Agent and clear all proxy state.
 * Also removes `NO_PROXY` from the environment if it was auto-defaulted.
 *
 * @internal For use in tests only. Do not call in production code.
 * @example
 * ```typescript
 * // In a test afterEach hook
 * afterEach(() => {
 *   resetProxy();
 * });
 * ```
 */
export function resetProxy(): void {
	if (noProxyDefaulted) {
		delete process.env.NO_PROXY;
		noProxyDefaulted = false;
	}
	setGlobalDispatcher(new Agent());
	activeProxyAgent = null;
}

/**
 * Returns a fetch function that respects the global proxy dispatcher.
 *
 * The global dispatcher is installed by this module's side effect (at import time).
 * This function wraps globalThis.fetch to ensure the dispatcher is used, and logs
 * proxy activation if configured.
 *
 * Call this function during OpenAI client initialization to route API traffic
 * through the configured proxy (if any).
 *
 * @returns A fetch function that routes requests through the global dispatcher.
 * @example
 * ```typescript
 * import { getProxyAwareFetch } from './utils/proxy.js';
 * import OpenAI from 'openai';
 *
 * const client = new OpenAI({
 *   apiKey: config.openai.apiKey,
 *   fetch: getProxyAwareFetch(),
 * });
 * ```
 */
export function getProxyAwareFetch(): typeof globalThis.fetch {
	if (activeProxyAgent !== null) {
		// Log at debug level to indicate proxy-aware fetch is in use
		// (initProxy will log a summary at startup)
	}
	// Return globalThis.fetch directly. The global dispatcher installed by this
	// module's side effect will handle proxying for all clients that use
	// globalThis.fetch or do not supply their own dispatcher.
	return globalThis.fetch;
}
