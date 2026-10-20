import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  GameService,
  NotFoundError,
  ValidationError,
  ConflictError,
  VersionConflictError,
} from '../service/gameService.js';
import { AiWorkflowService } from '../service/aiWorkflowService.js';

export interface CreateMcpServerOptions {
  name?: string;
  version?: string;
  gameService: GameService;
  aiWorkflowService?: AiWorkflowService;
}

/**
 * Creates and registers tools on an official MCP TypeScript SDK v2 McpServer.
 */
export function createDndMcpServer(options: CreateMcpServerOptions): McpServer {
  const { name = 'dnd-mcp-server', version = '0.2.0', gameService } = options;
  const aiWorkflowService =
    options.aiWorkflowService ?? new AiWorkflowService(gameService.database);

  const server = new McpServer({
    name,
    version,
  });

  // Tool 1: get_game_state (Phase 00)
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

  // Tool 2: resolve_test_attack (Phase 00)
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

  // Tool 3: get_event_log (Phase 00)
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

  // Tool 4: get_game_context (Phase 02 AI-DM)
  server.registerTool(
    'get_game_context',
    {
      description:
        'Returns sanitized scene context, party status, visible enemies, and recent narrations. Strictly omits hidden secrets.',
      inputSchema: {
        campaignId: z
          .string()
          .min(1)
          .describe("The campaign ID, e.g. 'poc-campaign'"),
      },
    },
    async (args) => {
      try {
        const context = aiWorkflowService.getGameContext(args.campaignId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(context, null, 2),
            },
          ],
        };
      } catch (err) {
        return formatMcpError(err);
      }
    }
  );

  // Tool 5: get_pending_actions (Phase 02 AI-DM)
  server.registerTool(
    'get_pending_actions',
    {
      description:
        'Returns queued player declarations waiting for DM mechanical resolution.',
      inputSchema: {
        campaignId: z
          .string()
          .min(1)
          .describe("The campaign ID, e.g. 'poc-campaign'"),
      },
    },
    async (args) => {
      try {
        const pending = aiWorkflowService.getPendingActions(args.campaignId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(pending, null, 2),
            },
          ],
        };
      } catch (err) {
        return formatMcpError(err);
      }
    }
  );

  // Tool 6: propose_resolution (Phase 02 AI-DM)
  server.registerTool(
    'propose_resolution',
    {
      description:
        'Allows the AI DM to propose a mechanical check/action (e.g. DC, skill, attack) before rolling or applying mutations.',
      inputSchema: {
        campaignId: z.string().min(1),
        actionId: z.string().min(1),
        pendingActionId: z.string().optional(),
        proposedResolutionType: z.enum([
          'ATTACK',
          'ABILITY_CHECK',
          'HEAL',
          'APPLY_DAMAGE',
          'MOVE',
          'REST',
          'NARRATIVE',
        ]),
        proposedRuleCitation: z.string().optional(),
        dc: z.number().int().min(1).optional(),
        parameters: z.record(z.string(), z.unknown()).default({}),
        explanation: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const proposal = aiWorkflowService.proposeResolution({
          campaignId: args.campaignId,
          actionId: args.actionId,
          pendingActionId: args.pendingActionId,
          proposedResolutionType: args.proposedResolutionType,
          proposedRuleCitation: args.proposedRuleCitation,
          dc: args.dc,
          parameters: args.parameters,
          explanation: args.explanation,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(proposal, null, 2),
            },
          ],
        };
      } catch (err) {
        return formatMcpError(err);
      }
    }
  );

  // Tool 7: resolve_action (Phase 02 AI-DM)
  server.registerTool(
    'resolve_action',
    {
      description:
        'Atomically executes an authoritative game command (ATTACK, HEAL, DAMAGE, MOVE, REST) and logs event.',
      inputSchema: {
        campaignId: z.string().min(1),
        actionId: z.string().min(1),
        expectedVersion: z.number().int().min(0),
        pendingActionId: z.string().optional(),
        command: z.discriminatedUnion('type', [
          z.object({
            type: z.literal('ATTACK'),
            attackerId: z.string().min(1),
            targetId: z.string().min(1),
            weaponId: z.string().optional(),
            advantageMode: z.enum(['none', 'advantage', 'disadvantage']).optional(),
          }),
          z.object({
            type: z.literal('HEAL'),
            targetId: z.string().min(1),
            amountFormula: z.string().min(1),
            source: z.string().min(1),
          }),
          z.object({
            type: z.literal('APPLY_DAMAGE'),
            targetId: z.string().min(1),
            amountFormula: z.string().min(1),
            damageType: z.string().min(1),
            source: z.string().min(1),
          }),
          z.object({
            type: z.literal('MOVE'),
            characterId: z.string().min(1),
            toX: z.number().int(),
            toY: z.number().int(),
          }),
          z.object({
            type: z.literal('REST'),
            characterId: z.string().min(1),
            restType: z.enum(['short', 'long']),
          }),
        ]),
      },
    },
    async (args) => {
      try {
        const result = aiWorkflowService.resolveAction(
          {
            campaignId: args.campaignId,
            actionId: args.actionId,
            expectedVersion: args.expectedVersion,
          },
          args.command,
          args.pendingActionId
        );

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

  // Tool 8: publish_narration (Phase 02 AI-DM)
  server.registerTool(
    'publish_narration',
    {
      description:
        'Publishes narrative fiction into the authorized public story feed. Cannot mutate numerical game state.',
      inputSchema: {
        campaignId: z.string().min(1),
        actionId: z.string().min(1),
        expectedVersion: z.number().int().min(0),
        text: z.string().min(1).describe('Narration text in English or Thai'),
        textTh: z.string().optional().describe('Optional Thai narration text'),
        speakerName: z.string().optional().describe('Name of the speaker or DM persona'),
      },
    },
    async (args) => {
      try {
        const result = aiWorkflowService.publishNarration(
          {
            campaignId: args.campaignId,
            actionId: args.actionId,
            expectedVersion: args.expectedVersion,
          },
          {
            text: args.text,
            textTh: args.textTh,
            speakerName: args.speakerName,
          }
        );

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
