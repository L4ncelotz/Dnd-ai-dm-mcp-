import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createDndMcpServer } from '../mcp/server.js';
import type { GameService } from '../service/gameService.js';

export interface HttpServerConfig {
  host?: string;
  port?: number;
  authToken?: string;
  gameService: GameService;
}

export interface RunningHttpServer {
  server: Server;
  host: string;
  port: number;
  close: () => Promise<void>;
}

export async function startHttpServer(config: HttpServerConfig): Promise<RunningHttpServer> {
  const host = config.host ?? '127.0.0.1';
  const port = config.port ?? 3000;
  const authToken = config.authToken ?? process.env.MCP_AUTH_TOKEN;

  const handler = createMcpHandler(async () => {
    return createDndMcpServer({ gameService: config.gameService });
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Basic CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'dnd-mcp-poc' }));
      return;
    }

    // Optional Bearer token check for remote tunnels / AI-GUI
    if (authToken) {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${authToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing Bearer token' }));
        return;
      }
    }

    try {
      const fullUrl = `http://${req.headers.host || `${host}:${port}`}${req.url}`;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value) continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }

      const isReadMethod = req.method === 'GET' || req.method === 'HEAD';
      const requestBody = isReadMethod ? null : Readable.toWeb(req);
      const webReq = new Request(fullUrl, {
        method: req.method,
        headers,
        body: requestBody,
        // duplex is required by Node.js fetch implementation when sending a streaming request body
        duplex: 'half',
      } as RequestInit);

      const webRes = await handler.fetch(webReq);

      const responseHeaders: Record<string, string> = {};
      webRes.headers.forEach((val, key) => {
        responseHeaders[key] = val;
      });

      res.writeHead(webRes.status, responseHeaders);

      if (webRes.body) {
        const reader = webRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Internal Server Error', detail: errorMsg }));
    }
  });

  const { promise, resolve, reject } = Promise.withResolvers<RunningHttpServer>();
  server.on('error', reject);
  server.listen(port, host, () => {
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    process.stderr.write(`[dnd-mcp] HTTP MCP server listening at http://${host}:${actualPort}/mcp\n`);
    resolve({
      server,
      host,
      port: actualPort,
      close: async () => {
        await handler.close();
        const closeResolvers = Promise.withResolvers<void>();
        server.close((err) => {
          if (err) closeResolvers.reject(err);
          else closeResolvers.resolve();
        });
        await closeResolvers.promise;
      },
    });
  });
  return promise;
}
