/**
 * Standardized response formatting utilities
 *
 * Every MCP tool handler returns a {@link StandardResponse}.  These helpers
 * build correctly-shaped response objects so handlers never construct them
 * by hand and cannot accidentally omit required fields.
 */

import { StandardResponse, ErrorType } from '../types/index.js';

/**
 * Build a successful {@link StandardResponse}.
 *
 * @param message - Human-readable summary of what happened.
 * @param data - Optional payload returned to the MCP client.
 * @param metadata - Optional key/value bag (e.g. `{ duration_ms: 42 }`).
 * @returns A `StandardResponse` with `success: true`.
 */
export function successResponse<T>(
	message: string,
	data?: T,
	metadata?: Record<string, any>,
): StandardResponse<T> {
	return {
		success: true,
		message,
		data,
		metadata,
	};
}

/**
 * Build a failed {@link StandardResponse}.
 *
 * @param message - Human-readable description of the failure.
 * @param errorType - Categorical error type for programmatic handling (default: `'UNKNOWN_ERROR'`).
 * @param error - Detailed error string or message (defaults to `message`).
 * @param metadata - Optional key/value bag with additional context.
 * @returns A `StandardResponse` with `success: false`.
 */
export function errorResponse(
	message: string,
	errorType: ErrorType = 'UNKNOWN_ERROR',
	error?: string,
	metadata?: Record<string, any>,
): StandardResponse {
	return {
		success: false,
		message,
		error: error ?? message,
		error_type: errorType,
		metadata,
	};
}

/**
 * Shorthand for a `VALIDATION_ERROR` response.
 *
 * @param message - Description of the validation failure.
 * @param details - Structured details (e.g. Zod error array) attached under `validation_details`.
 * @returns A `StandardResponse` with `error_type: 'VALIDATION_ERROR'`.
 */
export function validationError(message: string, details?: any): StandardResponse {
	return errorResponse(
		message,
		'VALIDATION_ERROR',
		message,
		details ? { validation_details: details } : undefined,
	);
}

/**
 * Shorthand for a `NOT_FOUND_ERROR` response.
 *
 * @param resource - Human-readable name of the resource that was not found
 *   (e.g. `'Memory with ID abc-123'`).
 * @returns A `StandardResponse` with `error_type: 'NOT_FOUND_ERROR'`.
 */
export function notFoundError(resource: string): StandardResponse {
	return errorResponse(
		`${resource} not found`,
		'NOT_FOUND_ERROR',
	);
}
