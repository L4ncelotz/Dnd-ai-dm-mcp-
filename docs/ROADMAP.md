# Roadmap - Explicit Vertical Slices

## Operating rules

- Only one active phase at a time. Ship thin, testable increments; do not build the final system speculatively.
- A gate is not passed by tests alone if the requirement says **manual AI-GUI test**.
- Prioritize persistence and consistency before visual polish.

## Phase 00 - MCP feasibility / durable state (START HERE)

**Deliver:** local MCP v2 server; SQLite test campaign; three MCP tools; repeatable tests; optional secure remote host integration if account permits.

**Gate:** MCP client calls tools; state persists after restart; duplicate action does not reapply; stale version rejects; real ChatGPT/Claude AI-GUI connection verified or reported blocked with evidence.

Details: [PHASE_00_POC.md](PHASE_00_POC.md).

## Phase 01 - Game core

- Domain models for campaigns, characters and action intents.
- Current State + immutable event log; generalized transactional command service.
- Dice parser and injectable RNG; seedable deterministic tests, secure production RNG.
- Three sample characters using a documented supported subset.

**Gate:** replay/retry/restart/concurrent mutation integration tests pass; no state transition from model prose.

## Phase 02 - AI-DM MCP workflow

- `get_game_context`, `get_pending_actions`, `propose_resolution`, `resolve_action`, `publish_narration` with appropriate validation.
- Limit outputs to what AI host may see; narratives published to an authorized shared feed.
- Document one-operator continuation and possible host confirmations.

**Gate:** AI-GUI demo resolves a small story scene through MCP while state stays correct.

## Phase 03 - Three-player web room

- React/Vite player view, authentication/session boundary, invite room, characters, action queue, narrated story, Socket.IO broadcasts.
- Host operator remains an ordinary player; no GM admin content appears in UI.

**Gate:** three browsers join, submit separate actions, see authorized consistent state, recover after reconnect.

## Phase 04 - Tactical map and combat

- 2D grid, tokens, walls, turn ordering, legal movement/reach, attacks and damage.
- Decide and document diagonal measuring, occlusion and visibility policy before coding.
- Do not implement a magical rule guessed by AI.

**Gate:** one complete three-player tactical encounter follows the explicitly supported rules subset.

## Phase 05 - Server-held encounters and secrets

- Procedural/template room, traps, hidden encounters, reveal conditions, basic fog of war.
- Server-side concealment, character-scoped discovery and regression tests for every public projection.
- Persistent journal and scene resume.

**Gate:** hidden information cannot be retrieved through normal player or MCP APIs before reveal; one-shot can resume after server restart.

## Phase 06 - Playtest + product polish

- Real 3-player, Thai-language one-shot, actionable feedback, bug and continuity fixes.
- UI responsiveness and accessibility, telemetry for tool errors and latency.

**Gate:** participants complete an adventure without needing a human to prepare content or silently repair state; known limitations documented.

## Deferred

RAG/vector search, custom character builder for all classes, comprehensive spell engine, auto AI narration on incoming web events (needs API/bot orchestration), voice, advanced VTT, AI-generated maps.
