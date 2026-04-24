#!/usr/bin/env node

/**
 * MCP Memory Server
 *
 * Model Context Protocol server for persistent semantic memory and knowledge
 * management. Uses OpenAI embeddings with Qdrant vector database to store,
 * search, and manage memories with automatic classification, secrets detection,
 * and workspace isolation.
 */

// Proxy MUST be the first import — sets the global fetch dispatcher before any HTTP client module initialises.
import { initProxy } from './utils/proxy.js';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { config } from './config.js';
import { logger } from './utils/logger.js';
import { tools } from './tools/index.js';
import { rulesManager } from './services/rules-manager.js';
import { extractErrorMessage } from './utils/errors.js';

/**
 * Initialize and start the MCP server
 */
async function main(): Promise<void> {
	logger.info('Starting MCP Memory Server...');

	// Initialize proxy configuration (if any proxy env vars are set)
	initProxy(logger);

	// Sanitize config to prevent logging sensitive information
	const sanitizedConfig = {
		...config,
		openai: {
			...config.openai,
			apiKey: config.openai.apiKey ? '***REDACTED***' : undefined,
		},
		qdrant: {
			...config.qdrant,
			apiKey: config.qdrant.apiKey ? '***REDACTED***' : undefined,
		},
	};
	logger.info(`Configuration: ${JSON.stringify(sanitizedConfig, null, 2)}`);

	// Initialize rules (copy to Claude directory if enabled)
	await rulesManager.initialize();

	// Read server version from package.json
	const serverVersion = JSON.parse(
		readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf-8'),
	).version as string;

	// Create MCP server instance
	const server = new Server(
		{
			name: 'mcp-memory',
			version: serverVersion,
		},
		{
			capabilities: {
				tools: {},
			},
		},
	);

	// Handler: List available tools
	server.setRequestHandler(ListToolsRequestSchema, () => {
		logger.debug('Listing available tools');
		return {
			tools: tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
			})),
		};
	});

	// Handler: Execute tool
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;

		logger.info(`Executing tool: ${name}`);
		logger.debug(`Arguments: ${JSON.stringify(args, null, 2)}`);

		// Find the tool handler
		const tool = tools.find(t => t.name === name);

		if (!tool) {
			logger.error(`Tool not found: ${name}`);
			throw new Error(`Unknown tool: ${name}`);
		}

		try {
			// Execute the tool handler
			const result = await tool.handler(args ?? {});

			logger.info(`Tool ${name} executed successfully`);
			logger.debug(`Result: ${JSON.stringify(result, null, 2)}`);

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		} catch (error) {
			logger.error(`Tool ${name} execution failed:`, error);

			const errorMessage = extractErrorMessage(error);

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							success: false,
							error: errorMessage,
							error_type: 'EXECUTION_ERROR',
						}, null, 2),
					},
				],
				isError: true,
			};
		}
	});

	// Start the server with stdio transport
	const transport = new StdioServerTransport();
	await server.connect(transport);

	logger.info('MCP Memory Server started successfully');
	logger.info('Listening on stdio transport');
}

// Handle shutdown gracefully
process.on('SIGINT', () => {
	logger.info('Received SIGINT, shutting down...');
	process.exit(0);
});

process.on('SIGTERM', () => {
	logger.info('Received SIGTERM, shutting down...');
	process.exit(0);
});

// Start the server
main().catch((error) => {
	logger.error('Fatal error:', error);
	process.exit(1);
});
