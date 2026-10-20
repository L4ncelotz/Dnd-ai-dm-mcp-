import { initDatabase } from './persistence/database.js';
import { GameService } from './service/gameService.js';
import { createDndMcpServer } from './mcp/server.js';
import { startStdioServer } from './transport/stdio.js';
import { startHttpServer } from './transport/http.js';

interface CliOptions {
  mode: 'stdio' | 'http';
  port: number;
  host: string;
  dbPath: string;
  remote: boolean;
}

function parseArgs(args: string[]): CliOptions {
  let mode: 'stdio' | 'http' = 'stdio';
  let port = 3000;
  let host = '127.0.0.1';
  let dbPath = 'data/poc.db';
  let remote = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--http') {
      mode = 'http';
    } else if (arg === '--stdio') {
      mode = 'stdio';
    } else if (arg === '--port' && i + 1 < args.length) {
      port = parseInt(args[++i], 10);
    } else if (arg === '--host' && i + 1 < args.length) {
      host = args[++i];
    } else if (arg === '--db' && i + 1 < args.length) {
      dbPath = args[++i];
    } else if (arg === '--remote') {
      remote = true;
    }
  }

  return { mode, port, host, dbPath, remote };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // Initialize SQLite database and seed fixture idempotently
  const db = initDatabase({ dbPath: options.dbPath });
  const gameService = new GameService(db);

  if (options.mode === 'http') {
    const httpRunning = await startHttpServer({
      host: options.host,
      port: options.port,
      remoteMode: options.remote,
      gameService,
    });

    const shutdown = async () => {
      process.stderr.write('\n[dnd-mcp] Shutting down HTTP server...\n');
      await httpRunning.close();
      db.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } else {
    const server = createDndMcpServer({ gameService });
    await startStdioServer(server);

    const shutdown = async () => {
      process.stderr.write('\n[dnd-mcp] Shutting down stdio server...\n');
      await server.close();
      db.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

main().catch((err) => {
  process.stderr.write(`[dnd-mcp] Fatal error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
