# AI Dungeon Master - MCP-first D&D Tabletop

Status: **Phase 00 (MCP PoC), Phase 01 (Game Core), and Phase 02 (AI-DM Workflow) implemented and verified** (2026-10-20).

## Mission

Build a private, Thai-first D&D tabletop for exactly three human players. All three play characters. An AI GUI (initially one conversation) acts as DM through a remote MCP server. A separate shared tabletop website presents the public game state. No player prepares or reads a campaign solution.

**North star:** The server is authoritative for state, dice and supported mechanics; the AI narrates and adjudicates open-ended fiction; the players make all character decisions.

## Starting decision

**Begin with Phase 00: MCP connectivity and persistent-state proof of concept.** Do not build a character creator, full rules system, map UI, RAG, or multiplayer frontend until the PoC has passed its gates.

## Read in order

1. [AGENTS.md](AGENTS.md) - instructions for coding agents.
2. [docs/PRODUCT.md](docs/PRODUCT.md) - goals, UX and acceptance criteria.
3. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - boundaries, privacy and state management.
4. [docs/ROADMAP.md](docs/ROADMAP.md) - incremental plan.
5. [docs/PHASE_00_POC.md](docs/PHASE_00_POC.md) - **first implementation task**.
6. [docs/DM_RUNBOOK.md](docs/DM_RUNBOOK.md) - operating a session without a human DM.
7. [AI_AGENT_HANDOFF.md](AI_AGENT_HANDOFF.md) - pasteable agent instruction.

## MVP shape (later, not Phase 00)

- One campaign, one three-player room, three premade level-1 characters.
- One AI-GUI DM session; one player volunteers to relay prompts or click Continue, but does **not** become the DM.
- Shared web: character sheets, map, dice log, public narration, campaign journal.
- Server-authoritative combat, positions, dice and durable game state.
- Server-held concealed information (unrevealed traps/enemies, encounters).
- One complete, repeatable one-shot scenario and resume after restart.

## Non-goals for MVP

Full 2024 D&D rules coverage, automated long-term plotting with perfect secrecy, GM-less autonomous responses to browser events, voice, image generation, multi-agent DM, vector DB/RAG, 3D maps, complex spell automation and monetization.

## Proposed stack, subject to PoC validation

- TypeScript on a supported Node.js LTS release.
- Official **MCP TypeScript SDK v2**: `@modelcontextprotocol/server`; test using the v2 client or MCP Inspector.
- HTTP transport for remote AI GUIs; start locally, then secure remote access.
- SQLite for single-instance persistence (WAL; serialized writes), later Drizzle ORM if schema complexity warrants it.
- Subsequent phases: Fastify, React + Vite, Socket.IO, Zod, 2D grid canvas.
- Keep MCP as an adapter around the game application service, not part of the game domain.

## Cost and host constraints

MCP does **not** itself provide a model. The AI GUI still requires an eligible account and remains subject to its usage limits and tool confirmation behavior. ChatGPT's full custom MCP write support is workspace- and role-gated. Remote HTTPS or a supported secure tunnel is required for ChatGPT; localhost alone is insufficient. Validate this before building the rest of the product. Avoid using an employer-managed workspace for a personal game unless authorized.

## Safety and licensing

- All game secrets remain server-side unless explicitly revealed by server rules. Chat tool traces may be inspectable by the player controlling the AI GUI, so hidden facts must never be returned to the AI GUI before reveal.
- Never trust AI tool arguments for state mutations; validate authorization, preconditions and version.
- Use SRD 5.2.1 as the licensed rules baseline and include required CC BY 4.0 attribution for SRD material. Never assume all D&D publications are freely usable.

## Authoritative references

- https://github.com/modelcontextprotocol/typescript-sdk
- https://ts.sdk.modelcontextprotocol.io/v2/
- https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- https://www.dndbeyond.com/srd

## Quickstart (Phase 00 PoC)

### 1. Requirements
- Node.js v22+ (v26 LTS recommended; uses built-in `node:sqlite` and web standard streams)
- npm v10+

### 2. Install dependencies
```bash
npm install
```

### 3. Run automated tests and typecheck
```bash
npm test               # Run all 18 Vitest unit & integration tests
npm run typecheck      # Verify TypeScript types with tsc --noEmit
```

### 4. Run MCP client smoke test
Executes the full 5-step manual acceptance sequence against an in-process MCP server with SQLite persistence:
```bash
npm run smoke:client
```

### 5. Running the MCP Server

#### Stdio Transport (Default)
For local AI clients (Claude Desktop, MCP Inspector, local host CLI):
```bash
npm start
```

#### HTTP Transport (For Remote AI GUIs / Tunnels)
For ChatGPT custom MCP connector, ngrok, or cloud tunnels:
```bash
npm run start:http
# Default listens on http://127.0.0.1:3000/mcp
# Custom port/host:
npx tsx src/index.ts --http --port 8080 --host 0.0.0.0
```

Check server health:
```bash
curl http://127.0.0.1:3000/health
```

Test smoke client against the running HTTP server:
```bash
npx tsx scripts/smoke-client.ts --url http://127.0.0.1:3000/mcp
```

### 6. Reset Database Fixture
Removes existing state and re-seeds `poc-campaign` (Hero 20/20 HP, Goblin 7/7 HP, Version 0):
```bash
npm run db:reset
```

## MCP Tools Exposed

1. `get_game_state({ campaignId })`: Returns current `stateVersion` and sanitized character HP / AC.
2. `resolve_test_attack({ campaignId, actionId, expectedVersion, attackerId, targetId })`: Rolls d20 and damage dice server-side, applies damage atomically, logs event, and checks state version and idempotency.
3. `get_event_log({ campaignId, limit })`: Bounded chronological audit log of game events.

## AI-GUI Host Integration Guide & Known Blockers

- **ChatGPT Custom Actions / MCP**: Requires a public HTTPS endpoint (or secure tunnel such as Cloudflare Tunnel / ngrok) and is subject to workspace role gating. Localhost alone is not directly reachable by ChatGPT cloud servers.
- **Authentication**: Set environment variable `MCP_AUTH_TOKEN=<secret>` to enforce Bearer token verification on all incoming MCP HTTP requests.

---

## Phase 01: Game Core Capabilities

### 1. Three Canonical Premade Characters (Level 1, SRD 5.2.1)
1. **Kaelen Stormborn (คาเลน สตอร์มบอร์น)** - Fighter (HP 12, AC 18, STR 16, Longsword +5, 1d8+3)
2. **Lyra Dawnseeker (ไลรา ดอว์นซีคเกอร์)** - Cleric (HP 10, AC 18, WIS 16, Mace +4, 1d6+2)
3. **Vael Whisperwind (วาเอล วิสเปอร์วินด์)** - Rogue (HP 9, AC 14, DEX 16, Shortsword +5, 1d6+3)

### 2. SRD Dice Engine (`src/domain/dice.ts`)
- Supports dice notation (`1d20+5`, `2d6+3`, `1d8+1d6+2`, `1d20-2`).
- Supports advantage (`advantage`: roll 2d20, keep highest, track discarded) and disadvantage (`disadvantage`: roll 2d20, keep lowest).
- Records full roll breakdown: dice terms, rolls, modifiers, and grand total.

### 3. Generalized Transactional Command Service (`src/service/commandService.ts`)
- Atomic state updates and event sourcing over SQLite.
- Commands supported:
  - `ATTACK`: weapon attacks, critical hit handling (doubled damage dice), AC check, damage application.
  - `HEAL`: dice-based healing clamped to `maxHp`.
  - `APPLY_DAMAGE`: environmental/trap damage clamped to 0.
  - `MOVE`: 2D spatial coordinate updates.
  - `REST`: short/long rests restoring character vitality.
- Event replay (`commandService.replayEvents(campaignId)`) verifies state consistency from immutable audit logs.

---

## Phase 02: AI-DM MCP Workflow

### MCP tools (8 total)
Phase 00 tools (`get_game_state`, `resolve_test_attack`, `get_event_log`) plus:

| Tool | Purpose |
|---|---|
| `get_game_context` | Sanitized scene + party + recent narrations. **Hidden traps/monsters are filtered server-side and never returned.** |
| `get_pending_actions` | Queued player intentions waiting for DM resolution. |
| `propose_resolution` | DM proposes check/DC/rule citation **before** rolling (SRD citation in `proposedRuleCitation`). |
| `resolve_action` | Executes ATTACK/HEAL/APPLY_DAMAGE/MOVE/REST atomically; consumes linked pending action. |
| `publish_narration` | Writes narrative fiction to the event feed; **cannot mutate HP/AC/positions** (enforced server-side). |

### One-operator continuation flow
1. Players submit intents via `submitPlayerAction` (queue). MCP has **no push channel** — the operator tells the AI GUI to continue.
2. DM reads `get_game_context` + `get_pending_actions`.
3. DM proposes the check/DC (`propose_resolution`), **then** resolves (`resolve_action` or ability check via `resolveAbilityCheck`).
4. DM publishes narration (`publish_narration`) using only returned outcomes.
5. Tool calls may require host confirmation (ChatGPT approval dialogs); design assumes human-initiated turns.

### Demo & verification
```bash
npm run scene:demo   # Full Thai-language story scene: queue -> propose -> check -> narrate (data/scene-demo.db)
```
