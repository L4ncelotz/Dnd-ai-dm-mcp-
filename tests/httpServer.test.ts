import { describe, it, expect } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttpServer } from '../src/transport/http.js';
import { initDatabase, POC_CAMPAIGN_ID } from '../src/persistence/database.js';
import { GameService } from '../src/service/gameService.js';
import { DeterministicRng } from '../src/domain/rng.js';

function extractText(callResult: { content?: unknown[] }): string {
  const first = callResult.content?.[0];
  if (first && typeof first === 'object' && 'text' in first && typeof first.text === 'string') {
    return first.text;
  }
  throw new Error('Tool result does not contain expected text payload');
}

describe('HTTP MCP Transport Integration', () => {
  it('serves /health and processes MCP tool requests over HTTP', async () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const rng = new DeterministicRng([13, 4]); // 13+4=17 hit, 4+2=6 damage
    const service = new GameService(db, rng);

    const running = await startHttpServer({
      host: '127.0.0.1',
      port: 0, // OS assigns random available port
      gameService: service,
    });

    try {
      // 1. Check health endpoint
      const healthRes = await fetch(`http://127.0.0.1:${running.port}/health`);
      expect(healthRes.status).toBe(200);
      const healthJson = (await healthRes.json()) as { status: string };
      expect(healthJson.status).toBe('ok');

      // 2. Connect MCP client over HTTP
      const clientTransport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${running.port}/mcp`)
      );
      const client = new Client({ name: 'test-http-client', version: '1.0.0' });
      await client.connect(clientTransport);

      // 3. List tools over HTTP
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('resolve_test_attack');

      // 4. Call resolve_test_attack over HTTP
      const attackCall = await client.callTool({
        name: 'resolve_test_attack',
        arguments: {
          campaignId: POC_CAMPAIGN_ID,
          actionId: 'http-action-1',
          expectedVersion: 0,
          attackerId: 'goblin-1',
          targetId: 'hero-1',
        },
      });

      expect(attackCall.isError).toBeFalsy();
      const attackData = JSON.parse(extractText(attackCall));
      expect(attackData.actionId).toBe('http-action-1');
      expect(attackData.stateVersion).toBe(1);
      expect(attackData.targetHp).toBe(14);

      await client.close();
    } finally {
      await running.close();
      db.close();
    }
  });

  it('rejects unauthorized requests when authToken is configured', async () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const service = new GameService(db);

    const running = await startHttpServer({
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token-123',
      gameService: service,
    });

    try {
      // Missing auth header -> 401
      const unauthRes = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(unauthRes.status).toBe(401);

      // Valid auth header passes auth check
      const authedRes = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-token-123',
        },
        body: JSON.stringify({}),
      });
      expect(authedRes.status).not.toBe(401);
    } finally {
      await running.close();
      db.close();
    }
  });
});
