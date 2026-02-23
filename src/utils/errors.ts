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
		return String((error as Record<string, unknown>).message);
	}
	return String(error);
}
