# PHASE 00 - MCP Connection + Persistent State PoC

**Status: TODO. This is the only authorized first implementation scope.**

## Question to answer

Can a single external AI GUI call our server's read/write MCP tools reliably, without direct LLM API integration, and can the server own durable dice/state changes that remain correct after retries and restart?

## Constraints

- One TypeScript Node.js server process; official MCP SDK v2 (`@modelcontextprotocol/server`) and Zod v4-compatible schemas.
- SQLite stored in a local ignored data path. A straightforward SQLite driver is enough for this PoC; do not add Drizzle unless it genuinely simplifies the three tables.
- Use a local test MCP client (or MCP Inspector) first. Only add remote transport/HTTPS/tunnel once local behavior works.
- No React, VTT, multiplayer, character builder, RAG, procedural story, or full D&D rule engine in Phase 00.
- No LLM API calls. Do not put secrets/credentials in tracked files.

## Fixture

Create a single campaign `poc-campaign` (state version 0), `hero-1` (20/20 HP, AC 14), and `goblin-1` with a simple fixed attack bonus and damage formula. The attack fixture is not a claim of full D&D 2024 rule compliance.

## MCP tools (three tools only)

1. `get_game_state({campaignId})` - read campaign version and safe visible character state.
2. `resolve_test_attack({campaignId, actionId, expectedVersion, attackerId, targetId})` - server rolls/checks/appends event/applies damage atomically. Fixed permitted actor/target for the fixture; reject invalid IDs. Return roll, result, new version and current HP. Production RNG must not be faked.
3. `get_event_log({campaignId, limit})` - return bounded non-secret events for auditing retries.

Keep each MCP handler thin; game service must also be callable directly by tests. Seed idempotently so restarts do not reset existing state.

## Transaction invariants

- Unique `actionId` for this campaign. A repeated identical action returns the original committed result, without rerolling or changing HP/version.
- Reuse of an existing `actionId` with different inputs fails with a conflict.
- For a previously unseen action, reject stale `expectedVersion` **before** making dice rolls.
- Record roll + resolved action + state update in one SQLite transaction. Failed/rolled-back actions must not leave partial state.
- HP cannot drop below 0 or exceed maximum. Be explicit if no hit occurs: event still records the action outcome and version increments once.
- MCP returns only sanitized, intentionally public fields. Never leak stack traces in public responses.

## Suggested build sequence

1. Initialize TypeScript app, scripts, `README` setup section and `.gitignore`.
2. Create SQLite schema, WAL setup and fixture seeding.
3. Implement pure deterministic attack resolver with injected RNG; secure runtime RNG for actual attempts.
4. Implement command service with SQLite transaction, duplicate detection and state version guard.
5. Register three MCP tools using the **v2** server API. Validate with Zod.
6. Add automated tests and a local MCP client smoke test.
7. Document `npm` commands for install, run, test, typecheck, and reset fixture data.
8. If the user's chosen AI GUI permits, expose authenticated **remote HTTPS/tunnel** and test real read & write tools; otherwise record blockers and stop without claiming success.

## Automated tests (minimum)

- `get_game_state` returns seeded hero HP 20 and version 0 on a fresh DB.
- A controlled hit from an injected deterministic RNG applies exactly the expected damage and logs roll details.
- Repeating the same actionId returns byte-for-byte equivalent logical result, no second event or HP change.
- Repeating same actionId with altered inputs fails.
- A new action with stale version rejects without rolling or mutating state.
- Invalid actor or target IDs are rejected.
- Restart process/open same DB and observe identical committed HP/version/event log.
- Simultaneous requests with the same actionId result in exactly one commit.
- Invalid MCP inputs cause schema errors, not crashes.

## Manual AI-GUI acceptance script

With an eligible ChatGPT/Claude host connected to the remote MCP endpoint:

1. Ask AI: "Use get_game_state for poc-campaign. State the HP and version as returned; don't invent values."
2. Ask AI: "Call resolve_test_attack with actionId `manual-001` and current version; report actual roll, HP and event ID."
3. Ask AI to repeat exactly `manual-001`; confirm response is reused, without new damage.
4. Restart the server; open a **new AI chat** and call `get_game_state`; compare state with prior result.
5. Attempt stale version or tampered actor ID, verify rejection.
6. Record prompts/tool results and any confirmations required by the host (without exposing credentials).

ChatGPT connection path (if permitted): Plugins -> Add custom MCP server -> public HTTPS endpoint or supported secure tunnel -> configure authentication -> install plugin and start a new chat with it selected. UI and permissions may vary. For ChatGPT Business, custom server creation is admin/owner-gated. Ineligible account? Mark host integration BLOCKED and use local MCP client test to continue the code PoC; **do not quietly fall back to paid APIs**.

## Done criteria

- `npm test` and `npm run typecheck` pass.
- Local MCP integration visibly works; commands documented.
- Persistence/retry/concurrency tests pass.
- Real external AI GUI smoke test is either verified, or distinctly marked blocked with the exact reason and next user action.
- Report files created, actual commands run, test output summary and next phase recommendation.

## Known uncertainty

The AI host may require confirmation for mutations and may not select tools automatically on every prompt. Do not design autonomous gameplay on the assumption that MCP can push a new model turn. MCP by itself saves direct API usage but does not remove host subscription limits.
