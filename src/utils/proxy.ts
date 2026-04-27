/**
 * HTTP(S) Proxy Configuration
 *
 * Installs a global fetch dispatcher using undici's EnvHttpProxyAgent when any
 * of the standard proxy environment variables are set (HTTPS_PROXY, HTTP_PROXY,
 * https_proxy, http_proxy).
 *
 * This module must be imported before any HTTP client is constructed, because it
 * patches the undici global dispatcher — affecting all HTTP clients:
 *   - OpenAI SDK (uses globalThis.fetch internally)
 *   - Qdrant JS client (passes its own undici Agent per-request; see fetch patch below)
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
const _proxyUrl = getActiveProxyUrl();

if (_proxyUrl !== null) {
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

	const agent = new EnvHttpProxyAgent();
	// TODO: Remove 'as unknown' casts once undici-types is bumped to match undici's onBodySent signature
	// (currently undici@8.1.0 with undici-types@6.21.0 via @types/node@22; signature mismatch in callback types)
	setGlobalDispatcher(agent as unknown as Parameters<typeof setGlobalDispatcher>[0]);
	activeProxyAgent = agent as unknown as Dispatcher;

	// The Qdrant JS client passes its own undici Agent instance as `dispatcher`
	// on every fetch call, which silently overrides the global dispatcher above.
	// Wrapping globalThis.fetch here intercepts those per-request dispatchers and
	// replaces them with our proxy-aware agent, so Qdrant traffic also goes through
	// the proxy.
	const _originalFetch = globalThis.fetch;

	// Override globalThis.fetch to intercept dispatcher arguments from Qdrant client.
	// The Qdrant JS client passes an undici Agent instance as `dispatcher` on every
	// fetch call, which overrides the global dispatcher. We intercept those requests
	// and replace the dispatcher with our proxy-aware agent.
	globalThis.fetch = ((
		input: Parameters<typeof fetch>[0],
		init?: Record<string, unknown> & { dispatcher?: unknown },
	): ReturnType<typeof fetch> => {
		// init may contain dispatcher from Qdrant client; replace it with our proxy-aware agent.
		// TODO: Remove 'as unknown' casts once undici-types is bumped to match undici's onBodySent signature
		// (currently undici@8.1.0 with undici-types@6.21.0 via @types/node@22; signature mismatch in callback types)
		// Type assertion: agent is EnvHttpProxyAgent (undici@8.1.0), but TypeScript expects
		// Dispatcher from undici-types. The onBodySent callback signature differs between versions.
		// Using 'unknown' bridges this version gap while preserving runtime compatibility — both
		// implement the same dispatch protocol.
		if (init !== undefined && typeof init === 'object' && 'dispatcher' in init) {
			return _originalFetch(input, { ...init, dispatcher: agent as unknown as Dispatcher } as unknown as Parameters<typeof _originalFetch>[1]);
		}
		return _originalFetch(input, init as unknown as Parameters<typeof _originalFetch>[1]);
	}) as unknown as typeof globalThis.fetch;
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
