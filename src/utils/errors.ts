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
 * Custom error for mcp-memory operations.
 *
 * Extends Error with a code property for programmatic error handling.
 * Always includes the original error as a cause for proper error chaining.
 *
 * @param message - Human-readable error message
 * @param code - Machine-readable error code (e.g., 'SECRET_DETECTED', 'INVALID_INPUT')
 * @param options - Optional ErrorOptions with cause for error chaining
 * @example
 * const cause = new Error('OpenAI API returned 429');
 * throw new MCPMemoryError(
 *   'Failed to generate embedding after retries',
 *   'EMBEDDING_FAILED',
 *   { cause }
 * );
 */
export class MCPMemoryError extends Error {
	public readonly code: string;

	constructor(message: string, code: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'MCPMemoryError';
		this.code = code;
	}
}
