import { Client, InMemoryTransport as ClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { initDatabase, POC_CAMPAIGN_ID } from '../src/persistence/database.js';
import { GameService } from '../src/service/gameService.js';
import { createDndMcpServer } from '../src/mcp/server.js';

interface ToolTextResult {
  text: string;
}

function extractText(callResult: { content?: unknown[] }): string {
  const first = callResult.content?.[0];
  if (first && typeof first === 'object' && 'text' in first && typeof first.text === 'string') {
    return first.text;
  }
  throw new Error('Missing text in MCP tool result');
}

async function runSmokeTest(): Promise<void> {
  const args = process.argv.slice(2);
  const httpArgIndex = args.indexOf('--url');
  const httpUrl = httpArgIndex !== -1 && args[httpArgIndex + 1] ? args[httpArgIndex + 1] : null;

  console.log('====================================================');
  console.log(' AI Dungeon Master - MCP Client Smoke Test (Phase 00)');
  console.log('====================================================\n');

  let client: Client;
  let cleanup: () => Promise<void>;

  if (httpUrl) {
    console.log(`Connecting to remote/local HTTP MCP server at ${httpUrl}...`);
    const transport = new StreamableHTTPClientTransport(new URL(httpUrl));
    client = new Client({ name: 'smoke-http-client', version: '0.1.0' });
    await client.connect(transport);
    cleanup = async () => {
      await client.close();
    };
  } else {
    console.log('Connecting to in-process MCP server with SQLite persistence at data/poc.db...');
    const db = initDatabase({ dbPath: 'data/poc.db' });
    const gameService = new GameService(db);
    const server = createDndMcpServer({ gameService });

    const [clientTransport, serverTransport] = ClientTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'smoke-local-client', version: '0.1.0' });
    await client.connect(clientTransport);

    cleanup = async () => {
      await client.close();
      await server.close();
      db.close();
    };
  }

  try {
    // Step 0: List tools
    console.log('\n[Step 0] Listing MCP tools...');
    const toolsList = await client.listTools();
    console.log('Available tools:', toolsList.tools.map((t) => t.name).join(', '));

    // Step 1: get_game_state
    console.log('\n[Step 1] Calling get_game_state({ campaignId: "poc-campaign" })...');
    const stateRes = await client.callTool({
      name: 'get_game_state',
      arguments: { campaignId: POC_CAMPAIGN_ID },
    });
    const stateData = JSON.parse(extractText(stateRes));
    console.log('Game State Response:');
    console.log(JSON.stringify(stateData, null, 2));
    const initialVersion = stateData.stateVersion;

    // Step 2: resolve_test_attack
    const actionId = `manual-smoke-${Date.now()}`;
    console.log(`\n[Step 2] Calling resolve_test_attack with actionId "${actionId}" and expectedVersion ${initialVersion}...`);
    const attackRes = await client.callTool({
      name: 'resolve_test_attack',
      arguments: {
        campaignId: POC_CAMPAIGN_ID,
        actionId,
        expectedVersion: initialVersion,
        attackerId: 'goblin-1',
        targetId: 'hero-1',
      },
    });
    const attackData = JSON.parse(extractText(attackRes));
    console.log('Attack Resolution:');
    console.log(JSON.stringify(attackData, null, 2));

    // Step 3: Repeated call with identical actionId (Idempotency test)
    console.log(`\n[Step 3] Repeating call with identical actionId "${actionId}" (Idempotency check)...`);
    const repeatRes = await client.callTool({
      name: 'resolve_test_attack',
      arguments: {
        campaignId: POC_CAMPAIGN_ID,
        actionId,
        expectedVersion: initialVersion,
        attackerId: 'goblin-1',
        targetId: 'hero-1',
      },
    });
    const repeatData = JSON.parse(extractText(repeatRes));
    console.log('Repeated Attack Response (isDuplicate should be true):');
    console.log(JSON.stringify(repeatData, null, 2));
    if (!repeatData.isDuplicate) {
      throw new Error('FAIL: Idempotent repeat did not flag isDuplicate: true');
    }

    // Step 4: Stale version rejection test
    console.log(`\n[Step 4] Calling resolve_test_attack with stale version ${initialVersion} (current is ${attackData.stateVersion})...`);
    const staleRes = await client.callTool({
      name: 'resolve_test_attack',
      arguments: {
        campaignId: POC_CAMPAIGN_ID,
        actionId: `manual-stale-${Date.now()}`,
        expectedVersion: initialVersion,
        attackerId: 'goblin-1',
        targetId: 'hero-1',
      },
    });
    console.log('Stale Version Rejection Response:');
    console.log(extractText(staleRes));
    if (!staleRes.isError) {
      throw new Error('FAIL: Stale version was not rejected');
    }

    // Step 5: get_event_log
    console.log('\n[Step 5] Calling get_event_log({ campaignId: "poc-campaign", limit: 5 })...');
    const logRes = await client.callTool({
      name: 'get_event_log',
      arguments: { campaignId: POC_CAMPAIGN_ID, limit: 5 },
    });
    const logData = JSON.parse(extractText(logRes));
    console.log(`Event Log (${logData.length} events):`);
    console.log(JSON.stringify(logData, null, 2));

    console.log('\n====================================================');
    console.log(' All smoke checks passed successfully!');
    console.log('====================================================\n');
  } finally {
    await cleanup();
  }
}

runSmokeTest().catch((err) => {
  console.error('\nSmoke test failed with error:', err);
  process.exit(1);
});
