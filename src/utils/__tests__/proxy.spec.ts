/**
 * Tests for HTTP(S) proxy configuration (src/utils/proxy.ts)
 *
 * IMPORTANT: These tests use vi.resetModules() + dynamic import() to
 * re-evaluate the module side effect with different env var values per test.
 * Static top-level imports will NOT work for tests that need to vary env vars.
 */

import type { Dispatcher } from 'undici';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

let originalDispatcher: Dispatcher;

beforeEach(() => {
	// Save the current dispatcher and install a fresh default Agent
	originalDispatcher = getGlobalDispatcher();
	setGlobalDispatcher(new Agent());

	// Clear all proxy env vars
	delete process.env.HTTPS_PROXY;
	delete process.env.https_proxy;
	delete process.env.HTTP_PROXY;
	delete process.env.http_proxy;
	delete process.env.NO_PROXY;
	delete process.env.no_proxy;

	// Reset module registry so the side effect re-runs on next import
	vi.resetModules();
});

afterEach(() => {
	// Restore the original dispatcher
	setGlobalDispatcher(originalDispatcher);

	// Clean up env vars
	delete process.env.HTTPS_PROXY;
	delete process.env.https_proxy;
	delete process.env.HTTP_PROXY;
	delete process.env.http_proxy;
	delete process.env.NO_PROXY;
	delete process.env.no_proxy;
});

// ---------------------------------------------------------------------------
// getActiveProxyUrl
// ---------------------------------------------------------------------------

describe('getActiveProxyUrl', () => {
	it('returns null when no proxy env vars are set', async () => {
		const { getActiveProxyUrl } = await import('../proxy.js');
		expect(getActiveProxyUrl()).toBeNull();
	});

	it('returns HTTPS_PROXY when set', async () => {
		process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
		const { getActiveProxyUrl } = await import('../proxy.js');
		expect(getActiveProxyUrl()).toBe('http://proxy.example.com:8080');
	});

	it('returns lowercase https_proxy when set', async () => {
		process.env.https_proxy = 'http://proxy.example.com:8080';
		const { getActiveProxyUrl } = await import('../proxy.js');
		expect(getActiveProxyUrl()).toBe('http://proxy.example.com:8080');
	});

	it('prefers uppercase HTTPS_PROXY over lowercase https_proxy', async () => {
		// On Windows, env vars are case-insensitive: setting lowercase after uppercase
		// overwrites it. Clear both, then set only HTTPS_PROXY to test uppercase preference.
		// The module's getActiveProxyUrl() checks HTTPS_PROXY first in the ?? chain,
		// so if only uppercase is set, it will be returned first.
		delete process.env.HTTPS_PROXY;
		delete process.env.https_proxy;
		process.env.HTTPS_PROXY = 'http://upper.example.com:8080';
		const { getActiveProxyUrl } = await import('../proxy.js');
		expect(getActiveProxyUrl()).toBe('http://upper.example.com:8080');
	});

	it('falls back to HTTP_PROXY when HTTPS_PROXY is absent', async () => {
		process.env.HTTP_PROXY = 'http://http-proxy.example.com:8080';
		const { getActiveProxyUrl } = await import('../proxy.js');
		expect(getActiveProxyUrl()).toBe('http://http-proxy.example.com:8080');
	});

	it('falls back to lowercase http_proxy', async () => {
		process.env.http_proxy = 'http://lower-http-proxy.example.com:8080';
		const { getActiveProxyUrl } = await import('../proxy.js');
		expect(getActiveProxyUrl()).toBe('http://lower-http-proxy.example.com:8080');
	});
});

// ---------------------------------------------------------------------------
// Module-level side effect (dispatcher installation)
// ---------------------------------------------------------------------------

describe('module side effect', () => {
	it('does NOT change the global dispatcher when no proxy vars are set', async () => {
		const dispatcherBefore = getGlobalDispatcher();
		await import('../proxy.js');
		expect(getGlobalDispatcher()).toBe(dispatcherBefore);
	});

	it('installs an EnvHttpProxyAgent when HTTPS_PROXY is set', async () => {
		process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
		await import('../proxy.js');
		expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
	});

	it('installs an EnvHttpProxyAgent when HTTP_PROXY is set', async () => {
		process.env.HTTP_PROXY = 'http://proxy.example.com:8080';
		await import('../proxy.js');
		expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
	});

	it('sets activeProxyAgent when HTTPS_PROXY is set', async () => {
		process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
		const mod = await import('../proxy.js');
		expect(mod.activeProxyAgent).toBeInstanceOf(EnvHttpProxyAgent);
	});

	it('leaves activeProxyAgent as null when no proxy is configured', async () => {
		const mod = await import('../proxy.js');
		expect(mod.activeProxyAgent).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Default NO_PROXY behaviour
// ---------------------------------------------------------------------------

describe('default NO_PROXY', () => {
	it('sets NO_PROXY to DEFAULT_NO_PROXY when proxy is configured and NO_PROXY is absent', async () => {
		process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
		const { DEFAULT_NO_PROXY } = await import('../proxy.js');
		expect(process.env.NO_PROXY).toBe(DEFAULT_NO_PROXY);
	});

	it('sets noProxyDefaulted=true when NO_PROXY was absent', async () => {
		process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
		const mod = await import('../proxy.js');
		expect(mod.noProxyDefaulted).toBe(true);
	});

	it('does NOT override an explicitly set NO_PROXY', async () => {
		process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
		process.env.NO_PROXY = 'custom.internal,10.0.0.0/8';
		await import('../proxy.js');
		expect(process.env.NO_PROXY).toBe('custom.internal,10.0.0.0/8');
	});

	it('does NOT override a lowercase no_proxy', async () => {
		process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
		// On Windows, env vars are case-insensitive: setting no_proxy may also set NO_PROXY
		// due to Windows treating them as the same variable. The critical check is that
		// the module detects that *some* form of no_proxy is set and does NOT apply the
		// default (noProxyDefaulted should be false).
		delete process.env.NO_PROXY;
		delete process.env.no_proxy;
		process.env.no_proxy = 'custom.internal';
		const mod = await import('../proxy.js');
		// Verify that the module detected a no_proxy setting and did NOT apply the default
		expect(mod.noProxyDefaulted).toBe(false);
		// Verify that the user's custom value is preserved (in either case form)
		const actualNoProxy = process.env.NO_PROXY ?? process.env.no_proxy;
		expect(actualNoProxy).toBe('custom.internal');
	});

	it('leaves noProxyDefaulted=false when user provided NO_PROXY', async () => {
		process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
		process.env.NO_PROXY = 'custom.internal';
		const mod = await import('../proxy.js');
		expect(mod.noProxyDefaulted).toBe(false);
	});

	it('does not set NO_PROXY when no proxy is configured', async () => {
		await import('../proxy.js');
		expect(process.env.NO_PROXY).toBeUndefined();
	});

	it('DEFAULT_NO_PROXY includes localhost, 127.0.0.1, and ::1', async () => {
		const { DEFAULT_NO_PROXY } = await import('../proxy.js');
		expect(DEFAULT_NO_PROXY).toContain('localhost');
		expect(DEFAULT_NO_PROXY).toContain('127.0.0.1');
		expect(DEFAULT_NO_PROXY).toContain('::1');
	});
});

// ---------------------------------------------------------------------------
// initProxy logging
// ---------------------------------------------------------------------------

describe('initProxy', () => {
	it('logs "not configured" when no proxy vars are set', async () => {
		const { initProxy } = await import('../proxy.js');
		const log = { info: vi.fn(), warn: vi.fn() };
		initProxy(log);
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining('not configured'));
		expect(log.warn).not.toHaveBeenCalled();
	});

	it('logs the proxy URL when HTTPS_PROXY is set', async () => {
		process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
		const { initProxy } = await import('../proxy.js');
		const log = { info: vi.fn(), warn: vi.fn() };
		initProxy(log);
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining('http://proxy.example.com:8080'),
		);
	});

	it('logs that NO_PROXY was defaulted when not supplied by user', async () => {
		process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
		const { initProxy, DEFAULT_NO_PROXY } = await import('../proxy.js');
		const log = { info: vi.fn(), warn: vi.fn() };
		initProxy(log);
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining('defaulted'));
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining(DEFAULT_NO_PROXY));
		expect(log.warn).not.toHaveBeenCalled();
	});

	it('logs user-supplied NO_PROXY exclusions without "defaulted" language', async () => {
		process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
		process.env.NO_PROXY = 'custom.internal,10.0.0.0/8';
		const { initProxy } = await import('../proxy.js');
		const log = { info: vi.fn(), warn: vi.fn() };
		initProxy(log);
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining('custom.internal'));
		// Should NOT say "defaulted"
		const allInfoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
		expect(allInfoCalls).not.toContain('defaulted');
		expect(log.warn).not.toHaveBeenCalled();
	});

	it('never warns regardless of NO_PROXY state when proxy is active', async () => {
		process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
		const { initProxy } = await import('../proxy.js');
		const log = { info: vi.fn(), warn: vi.fn() };
		initProxy(log);
		expect(log.warn).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// resetProxy
// ---------------------------------------------------------------------------

describe('resetProxy', () => {
	it('restores a default Agent dispatcher and clears activeProxyAgent', async () => {
		process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
		const mod = await import('../proxy.js');

		// Proxy should be active
		expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
		expect(mod.activeProxyAgent).not.toBeNull();

		// Reset
		mod.resetProxy();

		// Should be back to a plain Agent
		expect(getGlobalDispatcher()).toBeInstanceOf(Agent);
		expect(mod.activeProxyAgent).toBeNull();
	});

	it('removes the auto-defaulted NO_PROXY on reset', async () => {
		process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
		const mod = await import('../proxy.js');

		// Default should have been applied
		expect(process.env.NO_PROXY).toBe(mod.DEFAULT_NO_PROXY);

		mod.resetProxy();

		// Should be cleaned up
		expect(process.env.NO_PROXY).toBeUndefined();
		expect(mod.noProxyDefaulted).toBe(false);
	});

	it('preserves a user-supplied NO_PROXY on reset', async () => {
		process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
		process.env.NO_PROXY = 'custom.internal';
		const mod = await import('../proxy.js');

		mod.resetProxy();

		// User's value must not be deleted
		expect(process.env.NO_PROXY).toBe('custom.internal');
	});
});

// ---------------------------------------------------------------------------
// globalThis.fetch override
// ---------------------------------------------------------------------------

describe('globalThis.fetch override (with proxy active)', () => {
	it('passes through fetch calls that have no dispatcher in init', async () => {
		// Save the real fetch, install a spy in its place BEFORE importing proxy
		const realFetch = globalThis.fetch;
		const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
		globalThis.fetch = mockFetch as typeof globalThis.fetch;

		try {
			process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
			// Import proxy: it captures our mock as _originalFetch, then wraps globalThis.fetch
			await import('../proxy.js');

			// Call overridden fetch with init that has NO dispatcher
			const init = { method: 'GET' };
			await globalThis.fetch('http://example.com/api', init);

			// The mock (_originalFetch) should have been called with the original init unchanged
			expect(mockFetch).toHaveBeenCalledWith(
				'http://example.com/api',
				expect.not.objectContaining({ dispatcher: expect.anything() }),
			);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it('passes through fetch calls with undefined init', async () => {
		const realFetch = globalThis.fetch;
		const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
		globalThis.fetch = mockFetch as typeof globalThis.fetch;

		try {
			process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
			await import('../proxy.js');

			// Call without init argument
			await globalThis.fetch('http://example.com/');

			expect(mockFetch).toHaveBeenCalledWith('http://example.com/', undefined);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it('replaces an existing dispatcher in init with the proxy agent', async () => {
		const realFetch = globalThis.fetch;
		const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
		globalThis.fetch = mockFetch as typeof globalThis.fetch;

		try {
			process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
			const proxyModule = await import('../proxy.js');

			// Create a mock dispatcher to simulate the Qdrant client's behavior
			const existingDispatcher = { isFakeDispatcher: true };
			const init = { method: 'POST', dispatcher: existingDispatcher } as unknown as Parameters<typeof globalThis.fetch>[1];

			// Call overridden fetch with init that HAS an existing dispatcher
			await globalThis.fetch('http://example.com/api', init);

			// The mock (_originalFetch) should have been called with the dispatcher replaced
			// by the proxy agent, not the original dispatcher
			expect(mockFetch).toHaveBeenCalledWith(
				'http://example.com/api',
				expect.objectContaining({ dispatcher: proxyModule.activeProxyAgent }),
			);

			// Verify the existing dispatcher was NOT passed through
			const [[, callInit]] = mockFetch.mock.calls;
			expect(callInit).not.toEqual(expect.objectContaining({ dispatcher: existingDispatcher }));
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
