# Technical Architecture & Trust Boundaries

Version 0.1 | Status: proposed; validate through the PoC.

## Components

```text
          ONE AI GUI DM SESSION
             (host + MCP)
                  |
       remote HTTPS / secured tunnel
                  |
          [MCP adapter, auth]
                  |
        [Application game service] <---- [Player HTTP/WebSocket API]
            |      |     |                         ^
       [state] [rules] [dice]                      |
            |      |     |               3 shared-web player clients
           [SQLite: current state + append-only events]
                     |
         [server-held secrets/visibility projection]
```

The diagram represents **target architecture**, not existing code. MCP provides the interface to the AI host; MCP does not run an LLM and is not an event-driven DM trigger.

## Layers and ownership

1. Domain: pure TypeScript functions and documented rules; no MCP SDK or network imports.
2. Application: validates intents and preconditions, manages state transitions and events.
3. Persistence: SQLite with transactions, explicit state version and unique idempotency key.
4. Adapters: MCP tools and later REST/WebSocket call the same application services.
5. Presentation: Thai-first tabletop, receives a server-created authorized view.

## Phase 00 minimal data model

```text
campaign(id, state_version)
character(id, campaign_id, name, hp, max_hp, armor_class)
game_event(id, campaign_id, action_id UNIQUE, type, payload_json, state_version, created_at)
```

Seed only a fixed test campaign, Hero (20/20 HP, AC 14) and Goblin fixture. Test values are PoC fixtures, not comprehensive D&D rules. Phase 01 may introduce more normalized game tables and Drizzle migrations.

## Write flow (single source of truth)

1. Receive validated input with `actionId` / idempotency key and `expectedVersion`.
2. Authenticate caller; verify campaign scope and actor permission.
3. In one SQLite transaction, check for an existing action ID **first** (return stored result), then check state version and turn/legal-action preconditions.
4. Use server-side RNG for any necessary dice, apply a pure rule function, write new state and append event with roll/result.
5. Commit, then publish public state update (later via WebSocket). On timeout/retry, return prior event, never apply again.
6. Return an authorized projection, not raw database rows.

Use a single Node instance with WAL mode and a deliberate write queue or transactions to avoid SQLite write contention. Do not promise multi-instance scaling with this design.

## Scope of model judgment

- Allowed: narration, voices, scene descriptions using revealed facts, NPC intent, proposal of checks/DC **before** rolling for open-ended actions.
- Disallowed: direct HP edits, fabricated roll results, retroactive DC edits, mutation through prose, revealing server-hidden data, unsupported mechanics presented as official.
- MCP tools exposed to AI must have validated schemas, constrained campaign IDs and bounded results.

## Secrecy and spoilers

### Threat model

The AI-GUI operator is a **player** and may inspect visible conversation and tool traces. Consequently, secrets passed to the model/tool result must be assumed visible to that player. A server-held secret is genuinely secret only if it never crosses a player-visible interface before reveal.

### MVP approach

- Generate traps, concealed token positions and encounter secrets on the server from templates/seed; store privately.
- `get_game_context` reveals only authorized observations.
- `inspect`/`advance_scene` evaluate actual precommitted secret conditions server-side and return **only revealed outcomes**.
- Hide secret fields from normal player APIs, MCP tool outputs, debug logs and error responses; enforce field-level projections at service boundaries.
- Do not put plot-twist plans or unsolved secret NPC motives into the AI host context. It may creatively narrate public clues but cannot privately preplan a perfectly consistent long mystery without a separate trusted DM model boundary.
- Concealed game data and AI-host account data are distinct trust zones. A promise in a system prompt does not make DM secrets private.

### Authentication / networking

- Phase 00 local-only development, then expose a remote MCP endpoint only via TLS and an appropriate access-control scheme. Never expose unauthenticated write tools on the public internet.
- Guard MCP endpoint and later web player APIs separately; do not treat a Room Code as a secure write-token by itself.
- Protect against replay, double application, prompt injection via untrusted NPC/user text, cross-campaign access and unbounded request payloads.
- Use environment secrets and keep them out of logs/repo.

## Multiplayer and continuity

- Future clients submit player intents to a queue; the single AI GUI host reads queued intents when the operator tells it to continue.
- Host tool calls may require approval. MCP alone cannot cause ChatGPT to auto-generate the next response when a player presses a button on the website.
- Canonical state stored outside the model enables game resume; prose continuity is best effort based on saved world facts, recent event summaries and last scene.

## Rules and map assumptions

- SRD 5.2.1 is the rules content baseline, subject to CC BY 4.0 attribution and content restrictions.
- Spatial engine is deterministic: positions as grid coordinates, actual reach/range/walls, fixed diagonal policy.
- No fog or Line of Sight state computed by LLM vision or model memory.
- RAG not part of Phase 00 or MVP core state; later full-text retrieval for large world histories and SRD excerpts.

## Reference links

- MCP v2: https://ts.sdk.modelcontextprotocol.io/v2/
- MCP packages: https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server
- ChatGPT remote MCP: https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- D&D SRD: https://www.dndbeyond.com/srd
