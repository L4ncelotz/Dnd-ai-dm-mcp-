import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  GameService,
  NotFoundError,
  ValidationError,
  ConflictError,
  VersionConflictError,
} from '../service/gameService.js';

export interface CreateMcpServerOptions {
  name?: string;
  version?: string;
  gameService: GameService;
}

/**
 * Creates and registers tools on an official MCP TypeScript SDK v2 McpServer.
 */
export function createDndMcpServer(options: CreateMcpServerOptions): McpServer {
  const { name = 'dnd-mcp-poc', version = '0.1.0', gameService } = options;

  const server = new McpServer({
    name,
    version,
  });

  // Tool 1: get_game_state
  server.registerTool(
    'get_game_state',
    {
      description:
        'Read current campaign state version and visible character stats (HP, max HP, AC).',
      inputSchema: {
        campaignId: z
          .string()
          .min(1)
          .describe("The campaign ID to inspect, e.g. 'poc-campaign'"),
      },
    },
    async (args) => {
      try {
        const state = gameService.getGameState(args.campaignId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(state, null, 2),
            },
          ],
        };
      } catch (err) {
        return formatMcpError(err);
      }
    }
  );

  // Tool 2: resolve_test_attack
  server.registerTool(
    'resolve_test_attack',
    {
      description:
        'Atomically rolls and resolves a test attack, applies damage, increments state version, and logs event.',
      inputSchema: {
        campaignId: z
          .string()
          .min(1)
          .describe("The campaign ID, e.g. 'poc-campaign'"),
        actionId: z
          .string()
          .min(1)
          .describe('Unique idempotency key for this action (e.g. action-001)'),
        expectedVersion: z
          .number()
          .int()
          .min(0)
          .describe('Expected current campaign state version before executing this action'),
        attackerId: z
          .string()
          .min(1)
          .describe("ID of attacking character, e.g. 'hero-1' or 'goblin-1'"),
        targetId: z
          .string()
          .min(1)
          .describe("ID of target character, e.g. 'hero-1' or 'goblin-1'"),
      },
    },
    async (args) => {
      try {
        const result = gameService.resolveTestAttack({
          campaignId: args.campaignId,
          actionId: args.actionId,
          expectedVersion: args.expectedVersion,
          attackerId: args.attackerId,
          targetId: args.targetId,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return formatMcpError(err);
      }
    }
  );

  // Tool 3: get_event_log
  server.registerTool(
    'get_event_log',
    {
      description:
        'Returns bounded, non-secret chronological event log for the campaign to audit retries and state changes.',
      inputSchema: {
        campaignId: z
          .string()
          .min(1)
          .describe("The campaign ID, e.g. 'poc-campaign'"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(50)
          .describe('Maximum number of events to return (1-100, default: 50)'),
      },
    },
    async (args) => {
      try {
        const events = gameService.getEventLog(args.campaignId, args.limit);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(events, null, 2),
            },
          ],
        };
      } catch (err) {
        return formatMcpError(err);
      }
    }
  );

  return server;
}

function formatMcpError(err: unknown) {
  if (
    err instanceof NotFoundError ||
    err instanceof ValidationError ||
    err instanceof ConflictError ||
    err instanceof VersionConflictError
  ) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: err.name,
            message: err.message,
          }),
        },
      ],
    };
  }

  // Never leak internal stack traces to the MCP client/model
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'ServerError',
          message: 'An internal error occurred during tool execution: ' + message,
        }),
      },
    ],
  };
}
