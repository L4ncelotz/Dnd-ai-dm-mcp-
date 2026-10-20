# AI Dungeon Master - MCP-first D&D Tabletop

Status: **design complete; implementation not started** (2026-10-20).

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
