import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createDndMcpServer } from '../mcp/server.js';
import type { GameService } from '../service/gameService.js';

export interface HttpServerConfig {
  host?: string;
  port?: number;
  authToken?: string;
  remoteMode?: boolean;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  maxRequestBodyBytes?: number;
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
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const remoteMode = config.remoteMode ?? process.env.MCP_REMOTE_MODE === 'true';
  const maxBodyBytes = config.maxRequestBodyBytes ?? 1024 * 1024; // 1 MB default bound

  // P0-01 Security gate: refuse to bind to non-loopback or remote mode without authentication
  if ((!isLoopback || remoteMode) && (!authToken || !authToken.trim())) {
    throw new Error(
      `Security configuration error: Refusing to start HTTP MCP server on non-loopback interface '${host}' or in remote mode without MCP_AUTH_TOKEN configured.`
    );
  }

  const handler = createMcpHandler(async () => {
    return createDndMcpServer({ gameService: config.gameService });
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // 1. Origin validation
    const originHeader = req.headers.origin;
    if (config.allowedOrigins && config.allowedOrigins.length > 0) {
      if (originHeader && !config.allowedOrigins.includes(originHeader)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: Disallowed Origin' }));
        return;
      }
    }

    // 2. Host header validation
    const hostHeader = req.headers.host;
    if (config.allowedHosts && config.allowedHosts.length > 0) {
      if (!hostHeader || !config.allowedHosts.includes(hostHeader)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: Disallowed Host' }));
        return;
      }
    }

    // CORS headers
    const corsOrigin = config.allowedOrigins?.length
      ? (originHeader && config.allowedOrigins.includes(originHeader) ? originHeader : config.allowedOrigins[0])
      : '*';

    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Public health check (intentionally unauthenticated)
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'dnd-mcp-server' }));
      return;
    }

    // Request size guard
    const contentLength = req.headers['content-length'];
    if (contentLength && parseInt(contentLength, 10) > maxBodyBytes) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload Too Large: Request exceeds maximum allowed size' }));
      return;
    }

    // Authentication for MCP endpoint
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
      // P2-05: Redact internal exception leaks in public error responses; log details with incident ID
      const incidentId = randomUUID();
      process.stderr.write(
        `[dnd-mcp] [Incident:${incidentId}] HTTP handler error: ${err instanceof Error ? err.stack : String(err)}\n`
      );

      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(
        JSON.stringify({
          error: 'Internal Server Error',
          message: `An unexpected server error occurred (Incident ID: ${incidentId}).`,
        })
      );
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
