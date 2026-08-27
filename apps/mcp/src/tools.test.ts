import { describe, expect, it } from 'vitest';
import { MCP_TOOL_VERSION, TOOL_DEFINITIONS } from './tools.js';

describe('MCP tool definitions', () => {
  it('exposes repository discovery as an additive tool', () => {
    expect(MCP_TOOL_VERSION).toBe('1.1.0');
    expect(TOOL_DEFINITIONS.list_repositories).toBeDefined();
    expect(TOOL_DEFINITIONS.list_repositories.description).toContain('permitted');
    expect(TOOL_DEFINITIONS.list_repositories.description).toContain('scope.repo');
  });

  it('accepts an optional repository filter and bounded result limit', () => {
    const schema = TOOL_DEFINITIONS.list_repositories.inputSchema;

    expect(schema.query.safeParse(undefined).success).toBe(true);
    expect(schema.query.safeParse('PartshareV2').success).toBe(true);
    expect(schema.limit.safeParse(200).success).toBe(true);
    expect(schema.limit.safeParse(201).success).toBe(false);
  });
});
