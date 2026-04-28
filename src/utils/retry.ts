/**
 * Retry logic with exponential backoff
 */

import { logger } from './logger.js';

/**
 * Configuration options for {@link withRetry}.
 * All fields are optional; unset fields fall back to {@link DEFAULT_OPTIONS}.
 *
 * @example
 * ```typescript
 * const options: RetryOptions = {
 *   maxRetries: 5,
 *   initialDelay: 500,
 *   maxDelay: 60000,
 *   backoffFactor: 2,
 *   retryableErrors: ['ECONNRESET', 'ETIMEDOUT'],
 *   retryableStatusCodes: [502, 503],
 * };
 * const result = await withRetry(() => fetchData(), options);
 * ```
 */
export interface RetryOptions {
	/** Maximum number of attempts (including the first). A value of `3` means one initial attempt plus two retries (default: 3). */
	maxRetries?: number;
	/** Delay in milliseconds before the first retry (default: 1000). */
	initialDelay?: number;
	/** Upper bound on the computed delay to prevent extremely long waits (default: 30 000). */
	maxDelay?: number;
	/** Multiplier applied to the delay after each failed attempt (default: 2). */
	backoffFactor?: number;
	/** Node.js error codes (`error.code`) that should trigger a retry. */
	retryableErrors?: string[];
	/** HTTP status codes (`error.status`) that should trigger a retry. */
	retryableStatusCodes?: number[];
}

/** HTTP 500 Internal Server Error — transient server failure, safe to retry. */
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;
/** HTTP 502 Bad Gateway — upstream proxy/server error, safe to retry. */
const HTTP_STATUS_BAD_GATEWAY = 502;
/** HTTP 503 Service Unavailable — server overloaded or down, safe to retry. */
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
/** HTTP 504 Gateway Timeout — upstream timeout, safe to retry. */
const HTTP_STATUS_GATEWAY_TIMEOUT = 504;

/**
 * Production defaults for {@link RetryOptions}.
 * Network-error codes and common server-side HTTP status codes are retried
 * with exponential back-off capped at 30 seconds.
 */
const DEFAULT_OPTIONS: Required<RetryOptions> = {
	maxRetries: 3,
	initialDelay: 1000,
	maxDelay: 30000,
	backoffFactor: 2,
	retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'],
	retryableStatusCodes: [
		HTTP_STATUS_INTERNAL_SERVER_ERROR,
		HTTP_STATUS_BAD_GATEWAY,
		HTTP_STATUS_SERVICE_UNAVAILABLE,
		HTTP_STATUS_GATEWAY_TIMEOUT,
	],
};

/**
 * Execute an async operation with exponential back-off retry logic.
 *
 * Retries are attempted when the thrown error matches a retryable error code
 * or HTTP status code. Non-retryable errors propagate immediately.
 *
 * @param operation - Async function to attempt. Must be idempotent.
 * @param options - Override defaults for retry behaviour (maxRetries is the maximum number of total attempts, including the first).
 * @returns The value resolved by `operation` on success.
 * @throws The last error thrown by `operation` after all retries are exhausted,
 *         or immediately for non-retryable errors.
 *
 * @example
 * ```typescript
 * const data = await withRetry(() => fetch('https://api.example.com/data'));
 * ```
 */
export async function withRetry<T>(
	operation: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const opts = { ...DEFAULT_OPTIONS, ...options };

	if (opts.backoffFactor <= 0) {
		throw new Error(`backoffFactor must be a positive number, got ${opts.backoffFactor}`);
	}

	let lastError: unknown;

	for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
		try {
			return await operation();
		} catch (error) {
			lastError = error;

			// Convert to Error for logging and proper error handling
			let errorToLog: Error;
			if (error instanceof Error) {
				errorToLog = error;
			} else if (typeof error === 'object' && error !== null && 'message' in error) {
				errorToLog = new Error(String(error.message), { cause: error });
			} else {
				errorToLog = new Error(String(error));
			}

			// Check if error is retryable
			const isRetryable = isRetryableError(error, opts);

			if (!isRetryable || attempt === opts.maxRetries) {
				logger.error(`Operation failed after ${attempt} attempt(s):`, errorToLog);
				if (error instanceof Error) {
					throw error;
				}
				throw errorToLog;
			}

			// Calculate delay with exponential backoff
			const delay = Math.min(
				opts.initialDelay * Math.pow(opts.backoffFactor, attempt - 1),
				opts.maxDelay,
			);

			logger.warn(
				`Attempt ${attempt}/${opts.maxRetries} failed, retrying in ${delay}ms:`,
				errorToLog.message,
			);

			await sleep(delay);
		}
	}

	// This should never be reached, but throw with the original error as cause if it does
	if (lastError instanceof Error) {
		throw lastError;
	}
	throw new Error('Operation failed with unknown error', { cause: lastError });
}

/**
 * Determine whether a caught error qualifies for a retry attempt.
 *
 * Checks `error.status` against `options.retryableStatusCodes` and
 * `error.code` / `error.name` against `options.retryableErrors`.
 *
 * @param error - The error value thrown by the operation.
 * @param options - Resolved retry configuration.
 * @returns `true` if the operation should be retried, `false` otherwise.
 *
 * @example
 * ```typescript
 * const error = new Error('Connection reset');
 * (error as Record<string, unknown>).code = 'ECONNRESET';
 * const shouldRetry = isRetryableError(error, options);
 * console.log(shouldRetry); // true
 * ```
 */
function isRetryableError(error: unknown, options: Required<RetryOptions>): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const err = error as Record<string, unknown>;

	if (typeof err.status === 'number' && options.retryableStatusCodes.includes(err.status)) {
		return true;
	}
	if (typeof err.code === 'string' && options.retryableErrors.includes(err.code)) {
		return true;
	}
	if (typeof err.name === 'string' && options.retryableErrors.includes(err.name)) {
		return true;
	}
	return false;
}

/**
 * Sleep for a given number of milliseconds.
 *
 * @param ms - Duration to sleep in milliseconds.
 * @returns {Promise<void>} A promise that resolves after the specified duration.
 *
 * @example
 * ```typescript
 * await sleep(1000); // Sleep for 1 second
 * ```
 *
 * @internal
 */
async function sleep(ms: number): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, ms));
}
