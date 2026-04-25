import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		env: {
			LOG_LEVEL: 'silent',
			OPENAI_API_KEY: 'test-key',
		},
		include: ['src/**/*.{test,spec}.ts'],
		exclude: ['node_modules', 'build', 'tmp'],
		typecheck: {
			tsconfig: './tsconfig.test.json',
		},
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			exclude: [
				'node_modules/',
				'build/',
				'tmp/',
				'**/*.test.ts',
				'**/*.spec.ts',
				'**/types/**',
				'src/index.ts', // entry point — tested via integration tests only
				'src/schemas/**',
			],
			thresholds: {
				lines: 80,
				functions: 80,
				branches: 80,
				statements: 80,
			},
		},
	},
});
