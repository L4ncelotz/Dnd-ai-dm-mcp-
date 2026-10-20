import { describe, it, expect } from 'vitest';
import { Client, InMemoryTransport as ClientTransport } from '@modelcontextprotocol/client';
import { createDndMcpServer } from '../src/mcp/server.js';
import { initDatabase, POC_CAMPAIGN_ID } from '../src/persistence/database.js';
import { GameService } from '../src/service/gameService.js';
import { DeterministicRng } from '../src/domain/rng.js';

function extractToolText(callResult: { content?: unknown[] }): string {
  const first = callResult.content?.[0];
  if (first && typeof first === 'object' && 'text' in first && typeof first.text === 'string') {
    return first.text;
  }
  throw new Error('Tool result does not contain expected text payload');
}

describe('MCP Server v2 Integration & Tool Contracts', () => {
  async function setupMcpClient(gameService: GameService) {
    const server = createDndMcpServer({ gameService });
    const [clientTransport, serverTransport] = ClientTransport.createLinkedPair();

    await server.connect(serverTransport);

    const client = new Client({ name: 'test-mcp-client', version: '1.0.0' });
    await client.connect(clientTransport);

    return { server, client };
  }

  it('registers all 3 required tools', async () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const service = new GameService(db);
    const { client, server } = await setupMcpClient(service);

    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);

    expect(toolNames).toContain('get_game_state');
    expect(toolNames).toContain('resolve_test_attack');
    expect(toolNames).toContain('get_event_log');

    await client.close();
    await server.close();
    db.close();
  });

  it('Scenario 9: invalid MCP inputs cause schema errors, not server crashes', async () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const service = new GameService(db);
    const { client, server } = await setupMcpClient(service);

    // 1. Missing required field 'campaignId' in get_game_state
    const result1 = await client.callTool({
      name: 'get_game_state',
      arguments: {},
    });

    expect(result1.isError).toBe(true);
    expect(JSON.stringify(result1.content)).toMatch(/invalid|required/i);

    // 2. Invalid types in resolve_test_attack (expectedVersion as negative number)
    const result2 = await client.callTool({
      name: 'resolve_test_attack',
      arguments: {
        campaignId: POC_CAMPAIGN_ID,
        actionId: 'bad-input-1',
        expectedVersion: -5,
        attackerId: 'goblin-1',
        targetId: 'hero-1',
      },
    });

    expect(result2.isError).toBe(true);

    // 3. Unknown tool name fails gracefully
    await expect(
      client.callTool({
        name: 'non_existent_tool',
        arguments: {},
      })
    ).rejects.toThrow();

    // 4. Verify server is still alive and responsive after invalid calls
    const validCall = await client.callTool({
      name: 'get_game_state',
      arguments: { campaignId: POC_CAMPAIGN_ID },
    });
    expect(validCall.isError).toBeFalsy();

    await client.close();
    await server.close();
    db.close();
  });

  it('end-to-end tool execution: get_game_state -> resolve_test_attack -> get_event_log', async () => {
    const db = initDatabase({ dbPath: ':memory:' });
    // Goblin attacks hero: d20=11 (11+4=15 >= 14, Hit), damage d6=4 (4+2=6 damage)
    const rng = new DeterministicRng([11, 4]);
    const service = new GameService(db, rng);
    const { client, server } = await setupMcpClient(service);

    // 1. get_game_state
    const stateCall = await client.callTool({
      name: 'get_game_state',
      arguments: { campaignId: POC_CAMPAIGN_ID },
    });
    expect(stateCall.isError).toBeFalsy();
    const stateData = JSON.parse(extractToolText(stateCall));
    expect(stateData.campaignId).toBe(POC_CAMPAIGN_ID);
    expect(stateData.stateVersion).toBe(0);
    const hero = stateData.characters.find((c: { id: string }) => c.id === 'hero-1');
    expect(hero?.hp).toBe(20);

    // 2. resolve_test_attack
    const attackCall = await client.callTool({
      name: 'resolve_test_attack',
      arguments: {
        campaignId: POC_CAMPAIGN_ID,
        actionId: 'mcp-act-1',
        expectedVersion: 0,
        attackerId: 'goblin-1',
        targetId: 'hero-1',
      },
    });
    expect(attackCall.isError).toBeFalsy();
    const attackData = JSON.parse(extractToolText(attackCall));
    expect(attackData.actionId).toBe('mcp-act-1');
    expect(attackData.stateVersion).toBe(1);
    expect(attackData.damage).toBe(6);
    expect(attackData.targetHp).toBe(14);
    expect(attackData.isDuplicate).toBe(false);

    // 3. Repeat identical call via MCP -> returns cached result with isDuplicate: true
    const repeatCall = await client.callTool({
      name: 'resolve_test_attack',
      arguments: {
        campaignId: POC_CAMPAIGN_ID,
        actionId: 'mcp-act-1',
        expectedVersion: 0,
        attackerId: 'goblin-1',
        targetId: 'hero-1',
      },
    });
    expect(repeatCall.isError).toBeFalsy();
    const repeatData = JSON.parse(extractToolText(repeatCall));
    expect(repeatData.isDuplicate).toBe(true);
    expect(repeatData.targetHp).toBe(14);

    // 4. get_event_log
    const logCall = await client.callTool({
      name: 'get_event_log',
      arguments: {
        campaignId: POC_CAMPAIGN_ID,
        limit: 10,
      },
    });
    expect(logCall.isError).toBeFalsy();
    const logData = JSON.parse(extractToolText(logCall));
    expect(Array.isArray(logData)).toBe(true);
    expect(logData).toHaveLength(1);
    expect(logData[0].actionId).toBe('mcp-act-1');
    expect(logData[0].payload.damage).toBe(6);

    // 5. Tool returns sanitized error on non-existent campaign without stack traces
    const badCampaignCall = await client.callTool({
      name: 'get_game_state',
      arguments: { campaignId: 'unknown-campaign' },
    });
    expect(badCampaignCall.isError).toBe(true);
    const errorData = JSON.parse(extractToolText(badCampaignCall));
    expect(errorData.error).toBe('NotFoundError');
    expect(errorData.stack).toBeUndefined();

    await client.close();
    await server.close();
    db.close();
  });
});
