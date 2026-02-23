/**
 * Tests for retry logic with exponential backoff
 */

import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../retry.js';

describe('withRetry', () => {
	it('should succeed on first attempt', async () => {
		const operation = vi.fn().mockResolvedValue('success');

		const result = await withRetry(operation);

		expect(result).toBe('success');
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('should retry on retryable errors', async () => {
		const error = new Error('Connection reset');
		(error as any).code = 'ECONNRESET';

		const operation = vi
			.fn()
			.mockRejectedValueOnce(error)
			.mockResolvedValue('success');

		const result = await withRetry(operation, {
			maxRetries: 3,
			initialDelay: 10,
			retryableErrors: ['ECONNRESET'],
		});

		expect(result).toBe('success');
		expect(operation).toHaveBeenCalledTimes(2);
	});

	it('should retry on 500 status codes', async () => {
		const error = new Error('Server error');
		(error as any).status = 500;

		const operation = vi
			.fn()
			.mockRejectedValueOnce(error)
			.mockResolvedValue('success');

		const result = await withRetry(operation, {
			maxRetries: 3,
			initialDelay: 10,
		});

		expect(result).toBe('success');
		expect(operation).toHaveBeenCalledTimes(2);
	});

	it('should throw after max retries', async () => {
		const error = new Error('Connection reset');
		(error as any).code = 'ECONNRESET';

		const operation = vi.fn().mockRejectedValue(error);

		await expect(
			withRetry(operation, {
				maxRetries: 3,
				initialDelay: 10,
				retryableErrors: ['ECONNRESET'],
			}),
		).rejects.toThrow('Connection reset');

		expect(operation).toHaveBeenCalledTimes(3);
	});

	it('should not retry non-retryable errors', async () => {
		const operation = vi.fn().mockRejectedValue(new Error('Not retryable'));

		await expect(
			withRetry(operation, {
				maxRetries: 3,
				initialDelay: 10,
			}),
		).rejects.toThrow('Not retryable');

		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('should handle Error instances properly', async () => {
		const error = new Error('Test error');
		const operation = vi.fn().mockRejectedValue(error);

		await expect(
			withRetry(operation, { maxRetries: 1, initialDelay: 10 }),
		).rejects.toThrow('Test error');
	});

	it('should handle error objects with message property', async () => {
		const error = { message: 'Error object', code: 'TEST_ERROR' };
		const operation = vi.fn().mockRejectedValue(error);

		await expect(
			withRetry(operation, { maxRetries: 1, initialDelay: 10 }),
		).rejects.toThrow('Error object');
	});

	it('should handle string errors', async () => {
		const operation = vi.fn().mockRejectedValue('String error');

		await expect(
			withRetry(operation, { maxRetries: 1, initialDelay: 10 }),
		).rejects.toThrow('String error');
	});

	it('should succeed after multiple retries', async () => {
		const error = new Error('Transient failure');
		(error as any).code = 'ECONNRESET';

		const operation = vi
			.fn()
			.mockRejectedValueOnce(error)
			.mockRejectedValueOnce(error)
			.mockResolvedValue('eventual success');

		const result = await withRetry(operation, {
			maxRetries: 5,
			initialDelay: 10,
			retryableErrors: ['ECONNRESET'],
		});

		expect(result).toBe('eventual success');
		expect(operation).toHaveBeenCalledTimes(3);
	});

	it('should respect maxRetries boundary exactly', async () => {
		const error = new Error('Always fails');
		(error as any).code = 'ECONNRESET';
		const operation = vi.fn().mockRejectedValue(error);

		await expect(
			withRetry(operation, {
				maxRetries: 5,
				initialDelay: 10,
				retryableErrors: ['ECONNRESET'],
			}),
		).rejects.toThrow('Always fails');

		expect(operation).toHaveBeenCalledTimes(5);
	});

	it('should retry on 502, 503, and 504 status codes', async () => {
		for (const statusCode of [502, 503, 504]) {
			const error = new Error(`Status ${statusCode}`);
			(error as any).status = statusCode;
			const op = vi.fn()
				.mockRejectedValueOnce(error)
				.mockResolvedValue('ok');

			const result = await withRetry(op, { maxRetries: 3, initialDelay: 10 });
			expect(result).toBe('ok');
			expect(op).toHaveBeenCalledTimes(2);
		}
	});

	it('should NOT retry on 400 Bad Request', async () => {
		const error = new Error('Bad Request');
		(error as any).status = 400;
		const operation = vi.fn().mockRejectedValue(error);

		await expect(
			withRetry(operation, { maxRetries: 3, initialDelay: 10 }),
		).rejects.toThrow('Bad Request');

		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('should NOT retry on 404 Not Found', async () => {
		const error = new Error('Not Found');
		(error as any).status = 404;
		const operation = vi.fn().mockRejectedValue(error);

		await expect(
			withRetry(operation, { maxRetries: 3, initialDelay: 10 }),
		).rejects.toThrow('Not Found');

		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('should handle null/undefined thrown values', async () => {
		const operation = vi.fn().mockRejectedValue(null);

		await expect(
			withRetry(operation, { maxRetries: 1, initialDelay: 10 }),
		).rejects.toThrow('null');
	});
});
