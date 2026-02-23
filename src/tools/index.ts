/**
 * MCP Tools registry
 *
 * Central export for all available tools
 */

import { MCPTool } from '../types/index.js';
import { memoryTools } from './memory-tools.js';

/**
 * All available MCP tools
 *
 * Add new tools to this array as they are implemented
 */
export const tools: MCPTool[] = [
	...memoryTools,
];
