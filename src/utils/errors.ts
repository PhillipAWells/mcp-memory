/**
 * Error utility helpers
 *
 * Centralised functions for safely extracting error information from
 * values of unknown type, which is the norm when catching exceptions in
 * TypeScript strict mode.
 */

/** Maximum depth to traverse error cause chains. */
const MAX_CAUSE_DEPTH = 3;

/**
 * Safely extract a human-readable message from any thrown value.
 *
 * TypeScript's `catch (e)` gives `e: unknown`.  This helper collapses the
 * common cases into a plain string so callers don't need to repeat the same
 * type-narrowing guards everywhere.
 *
 * Follows the error cause chain up to 3 levels deep, including the cause
 * message in the output for better debugging context.
 *
 * @param error - Any value caught from a `try/catch` block.
 * @returns The best available string description of the error.
 * @example
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   const msg = extractErrorMessage(error);
 *   logger.error(`Operation failed: ${msg}`);
 * }
 * ```
 */
export function extractErrorMessage(error: unknown, depth = 0): string {
	if (depth > MAX_CAUSE_DEPTH) return '';

	let msg: string;

	if (error instanceof Error) {
		msg = error.message;
	} else if (typeof error === 'object' && error !== null && 'message' in error) {
		const messageValue = (error as Record<string, unknown>).message;
		msg = String(messageValue);
	} else {
		msg = String(error);
	}

	const cause = (error as Record<string, unknown>)?.cause;
	if (cause) {
		const causedBy = extractErrorMessage(cause, depth + 1);
		return msg + (causedBy ? ` (caused by: ${causedBy})` : '');
	}

	return msg;
}

/**
 * Custom error class for memory operations.
 *
 * Extends Error with a code property for categorizing different failure modes.
 * When wrapping another error, always pass the original error as the `cause`.
 *
 * NOTE: MemoryError is available for use in services when structured error codes
 * are needed. Current service implementations throw generic Errors for simplicity;
 * adopt MemoryError if callers need to programmatically distinguish error types.
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
