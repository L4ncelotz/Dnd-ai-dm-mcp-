# Copy/Paste to Coding Agent - First Task Only

You are implementing **Phase 00 only** for a private, Thai-first, three-player AI D&D tabletop. All three people are players; an external AI GUI will eventually act as a single DM by calling our MCP server. The game backend must be authoritative for state and dice.

Read these files **in order**: `README.md`, `AGENTS.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/PHASE_00_POC.md`.

**Task:** Implement the smallest runnable TypeScript MCP v2 proof of concept exactly as specified by `docs/PHASE_00_POC.md`.

Requirements:
- Use official MCP TypeScript **v2** `@modelcontextprotocol/server`; do not use obsolete v1 import paths.
- Implement three tools: `get_game_state`, `resolve_test_attack`, `get_event_log`.
- Use a SQLite database with idempotent seeding and persistent state after process restart.
- Implement server-authoritative dice, atomic state/event transactions, idempotency, version checks and strict validation.
- Tests must cover retry, stale versions, duplicate modified requests, restart and concurrent duplicates.
- Include a local MCP client smoke test and precise setup/run/test commands.
- Do not build web UI, campaign writer, full D&D rules, map, RAG or multiplayer in this phase.
- Do not call a paid LLM API, deploy to a public service, or push code without explicit approval.
- If an actual AI-GUI MCP connection cannot be tested due to host permissions/tunnel access, report that as a clearly marked manual blocker; do not claim verified interoperability.

Work on a small task branch if the repo is initialized. Make pragmatic choices and limit dependencies. Before finishing, run tests and typecheck and report their actual results. Return a concise summary of changed files, verification commands, known limitations, and next smallest phase.
