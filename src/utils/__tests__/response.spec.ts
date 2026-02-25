/**
 * Tests for response utility helpers
 */

import { describe, it, expect } from 'vitest';
import { successResponse, errorResponse, validationError, notFoundError } from '../response.js';

describe('Response utilities', () => {
	describe('successResponse', () => {
		it('should build a success response with minimal fields', () => {
			const result = successResponse('Operation completed');
			expect(result.success).toBe(true);
			expect(result.message).toBe('Operation completed');
			expect(result.data).toBeUndefined();
			expect(result.metadata).toBeUndefined();
		});

		it('should include data when provided', () => {
			const data = { id: 'test-123', name: 'Test' };
			const result = successResponse('Created', data);
			expect(result.data).toEqual(data);
		});

		it('should include metadata when provided', () => {
			const metadata = { duration_ms: 42, timestamp: '2024-01-01T00:00:00Z' };
			const result = successResponse('Done', undefined, metadata);
			expect(result.metadata).toEqual(metadata);
		});

		it('should include both data and metadata', () => {
			const data = { id: '123' };
			const metadata = { duration_ms: 100 };
			const result = successResponse('Success', data, metadata);
			expect(result.data).toEqual(data);
			expect(result.metadata).toEqual(metadata);
		});
	});

	describe('errorResponse', () => {
		it('should build an error response with default error type', () => {
			const result = errorResponse('Something went wrong');
			expect(result.success).toBe(false);
			expect(result.message).toBe('Something went wrong');
			expect(result.error).toBe('Something went wrong');
			expect(result.error_type).toBe('UNKNOWN_ERROR');
		});

		it('should use custom error type', () => {
			const result = errorResponse('Bad input', 'VALIDATION_ERROR');
			expect(result.error_type).toBe('VALIDATION_ERROR');
		});

		it('should use custom error message separate from message', () => {
			const result = errorResponse('Operation failed', 'TIMEOUT_ERROR', 'Request timed out');
			expect(result.message).toBe('Operation failed');
			expect(result.error).toBe('Request timed out');
		});

		it('should default error to message when not provided', () => {
			const result = errorResponse('Error occurred');
			expect(result.error).toBe('Error occurred');
		});

		it('should include metadata', () => {
			const metadata = { retryable: true };
			const result = errorResponse('Failed', 'CONNECTION_ERROR', 'Connection lost', metadata);
			expect(result.metadata).toEqual(metadata);
		});
	});

	describe('validationError', () => {
		it('should create a validation error without details', () => {
			const result = validationError('Invalid input');
			expect(result.success).toBe(false);
			expect(result.error_type).toBe('VALIDATION_ERROR');
			expect(result.message).toBe('Invalid input');
			expect(result.metadata).toBeUndefined();
		});

		it('should create a validation error with details', () => {
			const details = [{ field: 'email', message: 'Invalid email' }];
			const result = validationError('Validation failed', details);
			expect(result.error_type).toBe('VALIDATION_ERROR');
			expect(result.metadata).toEqual({ validation_details: details });
		});

		it('should handle null details', () => {
			const result = validationError('Failed', null);
			expect(result.metadata).toBeUndefined();
		});

		it('should handle undefined details', () => {
			const result = validationError('Failed', undefined);
			expect(result.metadata).toBeUndefined();
		});
	});

	describe('notFoundError', () => {
		it('should create a not found error', () => {
			const result = notFoundError('User with ID 123');
			expect(result.success).toBe(false);
			expect(result.error_type).toBe('NOT_FOUND_ERROR');
			expect(result.message).toBe('User with ID 123 not found');
			expect(result.error).toBe('User with ID 123 not found');
		});

		it('should work with various resource names', () => {
			const result = notFoundError('Memory abc-def-ghi');
			expect(result.message).toBe('Memory abc-def-ghi not found');
		});
	});
});
