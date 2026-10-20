# Instructions for Coding Agents

This is a **private three-player D&D platform**. The owner wants a practical, simple and maintainable solution, not speculative functionality.

## Precedence

1. Explicit current user instructions.
2. `docs/PHASE_00_POC.md` for Phase 00 work.
3. `docs/ARCHITECTURE.md`, `docs/PRODUCT.md`, `docs/ROADMAP.md`.
4. This file.

## Mandatory working behavior

- Read the repo structure and the docs before changing code. If there is existing code, inspect it and make surgical changes.
- Implement **only the active phase**. Do not create full UI, battle maps, vector search, multi-agent architecture, or extra hosting integrations prematurely.
- Prefer plain TypeScript, explicit contracts and minimal dependencies. Start with one runnable server, not microservices.
- Keep game state changes inside a single application-service boundary. MCP handlers should be thin adapters.
- Use schema validation for all MCP requests and reject invalid inputs.
- Use SQLite transactions for changes plus event logging; enforce idempotency and optimistic state version checks.
- Dice outcomes must come from a genuine RNG in production, not fabricated by a model. Tests must be reproducible via injected RNG.
- Never expose secret data through ordinary API/MCP results, logs, stack traces or client-side payloads.
- Keep host/model credentials outside source control; ship `.env.example` if needed and a `.gitignore`.
- Prefer dependency versions confirmed from official docs; the current official MCP TypeScript SDK is v2, not the old monolithic v1 import paths.
- Include automated tests for success, rejection, retry, restart persistence and visibility constraints relevant to the current phase.
- Do not claim real AI-host interoperability unless it has actually been manually demonstrated. Report permissions/connectivity blockers explicitly.
- Do not use an OpenAI or other paid API without explicit authorization. This project is MCP-first to reduce marginal LLM API expense.
- Work on a task branch if a Git repository exists. Do not push or deploy without user authorization.

## Deliver each phase with

1. A brief change summary.
2. Commands to install, run, test and typecheck.
3. Tests actually executed and their results; disclose what was not tested.
4. Any unresolved blockers, especially AI-GUI MCP permissions and remote access.
5. The next smallest slice (without implementing it in this task).

## Critical design boundaries

- AI = narration and judgment about ambiguous actions.
- Server = authoritative state, RNG, allowed game mechanics and access control.
- Database = durable character, campaign and event records.
- Shared web = public/authorized representation, never a secret-state dump.
- A single AI GUI conversation does NOT wake up automatically when a browser user submits an action. It needs human-initiated continuation or later a separate API-based orchestrator.
