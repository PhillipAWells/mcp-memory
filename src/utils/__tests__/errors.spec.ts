/**
 * Tests for error utility helpers
 */

import { describe, it, expect } from 'vitest';
import { extractErrorMessage, MemoryError } from '../errors.js';

describe('extractErrorMessage', () => {
	it('should extract message from Error instances', () => {
		const error = new Error('Test error message');
		expect(extractErrorMessage(error)).toBe('Test error message');
	});

	it('should extract message from objects with message property', () => {
		const error = { message: 'Object error message' };
		expect(extractErrorMessage(error)).toBe('Object error message');
	});

	it('should extract message from custom error objects', () => {
		const error = {
			message: 'Custom error',
			code: 'CUSTOM_CODE',
			context: 'some context',
		};
		expect(extractErrorMessage(error)).toBe('Custom error');
	});

	it('should handle strings', () => {
		const error = 'String error message';
		expect(extractErrorMessage(error)).toBe('String error message');
	});

	it('should handle numbers', () => {
		const error = 404;
		expect(extractErrorMessage(error)).toBe('404');
	});

	it('should handle null', () => {
		expect(extractErrorMessage(null)).toBe('null');
	});

	it('should handle undefined', () => {
		expect(extractErrorMessage(undefined)).toBe('undefined');
	});

	it('should handle boolean values', () => {
		expect(extractErrorMessage(true)).toBe('true');
		expect(extractErrorMessage(false)).toBe('false');
	});

	it('should handle empty strings', () => {
		expect(extractErrorMessage('')).toBe('');
	});

	it('should handle objects without message property', () => {
		const error = { code: 'ERROR_CODE', details: 'some details' };
		expect(extractErrorMessage(error)).toBe('[object Object]');
	});

	it('should handle Error subclasses', () => {
		class CustomError extends Error {
			constructor(message: string) {
				super(message);
				this.name = 'CustomError';
			}
		}
		const error = new CustomError('Subclass error');
		expect(extractErrorMessage(error)).toBe('Subclass error');
	});

	it('should handle arrays', () => {
		const error = ['error', 'details'];
		expect(extractErrorMessage(error)).toBe('error,details');
	});

	it('should handle non-string message property values', () => {
		const error = { message: 123 };
		expect(extractErrorMessage(error)).toBe('123');
	});

	it('should handle objects with null message property', () => {
		const error = { message: null };
		expect(extractErrorMessage(error)).toBe('null');
	});

	it('should handle complex nested errors', () => {
		const innerError = new Error('Inner error');
		const outerError = { message: innerError.message, wrapped: innerError };
		expect(extractErrorMessage(outerError)).toBe('Inner error');
	});

	it('includes cause message when error has a cause property', () => {
		const inner = new Error('inner cause');
		const outer = new Error('outer error', { cause: inner });
		expect(extractErrorMessage(outer)).toBe('outer error (caused by: inner cause)');
	});

	it('stops traversing cause chains at MAX_CAUSE_DEPTH', () => {
		// Build a chain 5 levels deep: e1 → e2 → e3 → e4 → e5
		const e5 = new Error('level-5');
		const e4 = new Error('level-4', { cause: e5 });
		const e3 = new Error('level-3', { cause: e4 });
		const e2 = new Error('level-2', { cause: e3 });
		const e1 = new Error('level-1', { cause: e2 });
		const result = extractErrorMessage(e1);
		// Levels 1-4 should appear (depth 0-3 are within limit)
		expect(result).toContain('level-1');
		expect(result).toContain('level-4');
		// Level 5 should NOT appear (depth 4 exceeds MAX_CAUSE_DEPTH=3)
		expect(result).not.toContain('level-5');
	});

	it('returns empty string when called with depth exceeding MAX_CAUSE_DEPTH', () => {
		// Direct test of the depth guard: depth=4 > MAX_CAUSE_DEPTH=3
		expect(extractErrorMessage(new Error('any'), 4)).toBe('');
	});
});

describe('MemoryError', () => {
	it('constructor sets name to MemoryError', () => {
		const error = new MemoryError('TEST_CODE', 'Test message');
		expect(error.name).toBe('MemoryError');
	});

	it('constructor sets message correctly', () => {
		const error = new MemoryError('TEST_CODE', 'Test error message');
		expect(error.message).toBe('Test error message');
	});

	it('constructor sets code property', () => {
		const error = new MemoryError('TEST_CODE', 'Test message');
		expect(error.code).toBe('TEST_CODE');
	});

	it('cause is set when options with cause are passed', () => {
		const originalError = new Error('Original error');
		const error = new MemoryError('TEST_CODE', 'Test message', { cause: originalError });
		expect(error.cause).toBe(originalError);
	});

	it('is an instance of Error', () => {
		const error = new MemoryError('TEST_CODE', 'Test message');
		expect(error).toBeInstanceOf(Error);
	});

	it('is an instance of MemoryError', () => {
		const error = new MemoryError('TEST_CODE', 'Test message');
		expect(error).toBeInstanceOf(MemoryError);
	});
});
