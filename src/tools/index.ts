/**
 * MCP Tools registry
 *
 * Central export for all available tools
 */

import type { MCPTool } from '../types/index.js';
import { memoryTools } from './memory-tools.js';

/**
 * Central registry of all available MCP tools.
 *
 * Add new tools to this array as they are implemented. Currently includes
 * all 9 memory tools from {@link memoryTools}.
 *
 * @example
 * ```typescript
 * // Used by the MCP server to register all available tools
 * tools.forEach(tool => console.log(tool.name)); // 'memory-store', 'memory-query', etc.
 * ```
 */
export const tools: MCPTool[] = [
	...memoryTools,
];
