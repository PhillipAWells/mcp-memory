/**
 * Error utility helpers
 *
 * Centralised functions for safely extracting error information from
 * values of unknown type, which is the norm when catching exceptions in
 * TypeScript strict mode.
 */

/**
 * Safely extract a human-readable message from any thrown value.
 *
 * TypeScript's `catch (e)` gives `e: unknown`.  This helper collapses the
 * common cases into a plain string so callers don't need to repeat the same
 * type-narrowing guards everywhere.
 *
 * @param error - Any value caught from a `try/catch` block.
 * @returns The best available string description of the error.
 */
export function extractErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === 'object' && error !== null && 'message' in error) {
		const msg = error.message;
		return String(msg);
	}
	return String(error);
}

/**
 * Custom error class for memory operations.
 *
 * Extends Error with a code property for categorizing different failure modes.
 * When wrapping another error, always pass the original error as the `cause`.
 *
 * @example
 * ```typescript
 * try {
 *   await qdrant.upsert(points);
 * } catch (cause) {
 *   throw new MemoryError('STORAGE_FAILED', 'Failed to store memory', { cause });
 * }
 * ```
 */
export class MemoryError extends Error {
	/**
	 * Error code for categorizing the failure.
	 * Common codes: STORAGE_FAILED, SEARCH_FAILED, VALIDATION_FAILED, WORKSPACE_INVALID
	 */
	public readonly code: string;

	/**
	 * Create a new MemoryError.
	 *
	 * @param code - Error code for categorizing the failure
	 * @param message - Human-readable error message
	 * @param options - Optional { cause } to chain from another error
	 */
	constructor(
		code: string,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message);
		this.name = 'MemoryError';
		this.code = code;
		if (options?.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}
