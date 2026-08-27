import { describe, expect, it } from 'vitest';
import { refreshSessionIdentity } from './session.js';
import type { McpIdentity } from './context.js';

function identity(principalId: string, projectId: string): McpIdentity {
  return {
    principal: {
      id: principalId,
      orgId: 'org_local',
      subject: principalId,
      email: null,
      clearance: 'internal',
      isServiceAccount: false,
    },
    audience: 'https://mcp.kna.internal',
    scopes: ['kna:search'],
    inferredProjectId: projectId,
    clientName: 'test',
    expiresAt: Date.now() + 60_000,
  };
}

describe('refreshSessionIdentity', () => {
  it('updates the object captured by handlers to the user on the current token', () => {
    const captured = identity('user_a', 'project_a');
    const sameReference = captured;

    refreshSessionIdentity(captured, identity('user_b', 'project_b'));

    expect(captured).toBe(sameReference);
    expect(captured.principal.id).toBe('user_b');
    expect(captured.inferredProjectId).toBe('project_b');
  });
});
