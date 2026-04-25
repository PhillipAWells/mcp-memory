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
