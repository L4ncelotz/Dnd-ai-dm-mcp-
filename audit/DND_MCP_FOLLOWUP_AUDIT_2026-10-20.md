# Dnd-ai-dm-mcp- — Post-hardening review of uploaded `dnd.zip`

**Date:** 2026-10-20  
**Scope:** Uploaded source snapshot, Phase 00–02 hardening, readiness for Phase 03.  
**Source inspected:** `dnd.zip`, extracted without `.git` and with its Windows `node_modules` only for execution attempts.  
**Verdict:** **NOT YET READY FOR PHASE 03.** Previous hardening fixed numerous issues, but several important invariants are still bypassable in live code.

## Verified commands / environment

- Node `v22.16.0`, npm `10.9.2`, Linux review environment.
- `node node_modules/typescript/bin/tsc --noEmit` — **PASS** (exit 0).
- `node node_modules/typescript/bin/tsc` — **PASS** (exit 0).
- `node dist/scripts/smoke-client.js` — **PASS**, local in-memory MCP transport and SQLite fixture.
- `node dist/scripts/scene-demo.js` — **PASS**, standalone AI workflow service demo.
- `node node_modules/vitest/vitest.mjs run` — **BLOCKED**, not a test failure: uploaded dependencies were installed on Windows and omit `@rollup/rollup-linux-x64-gnu` required to execute Vitest on Linux. `npm install` could not reach npm registry (`EAI_AGAIN`). Typecheck/build/smoke still executed successfully.
- **No live ChatGPT/Claude remote-host connector test was performed or proven.**
- The source contains **58** `it(...)` test cases across 8 test files (the README's “18 tests” quickstart statement is stale).

## What improved since the earlier audit

Confirmed present in source: remote-mode/bind-address token gate; MCP `resolve_ability_check`; persisted `resolution_proposals`; transactional pending-action consumption; explicit character role/visibility filtering in state/context; latest-N event query; skill proficiency/expertise; doubled damage dice for composite critical hits; zero damage floor for weapon attacks; safe generic internal error responses; added hardening tests.

**Important distinction:** These mechanisms exist but are not complete across the entire tool/read/write surface.

## Reproduced outstanding defects

All R1–R9 below were executed against freshly initialized **in-memory SQLite** databases using compiled service code (`dist/src`), not inferred from comments. R10–R11 were exercised with a real local HTTP listener.

### P0-01 — Hidden information leaks through `get_event_log` (R6)

**Source:** `src/service/gameService.ts:267-292`, `src/mcp/server.ts:117-152`, `src/service/commandService.ts:317-425`.

**Repro:** A `visibility='hidden'` entity (`goblin-ambush-1`) performs an attack. `getGameState` correctly omits it, but `getEventLog` includes its ID in unfiltered event payload. The MCP tool exposes the same method.

**Observed:** `hiddenInGameState=false`, `hiddenInEventLog=true`.

**Fix:** Add one centralized audience/visibility projection for **all** MCP read tools, mutation results, event feeds, and future Web APIs. Never return raw event payloads to player-visible channels. Consider concealing exact HP/AC of visible enemies as well (`get_game_state` / `get_game_context` currently expose both).

**Test:** Trigger an event from a hidden enemy; assert secret identifier/stats never appear in any player-observable tool output before an explicit server-side reveal.

### P1-01 — A locked ability-check DC can be bypassed (R1)

**Source:** `src/mcp/server.ts:265-315`, `src/service/aiWorkflowService.ts:352-441`.

**Repro:** Persist a proposal with DC 15, then call `resolveAbilityCheck` with DC 1, omitting optional `proposalId` and `pendingActionId`.

**Observed:** check resolved with DC 1 and advanced the state version.

**Fix:** In live/story mode, require a persisted immutable proposal linked to a pending action. If ad-hoc diagnostic checks are needed, expose them as explicitly test-only tooling, not as live authoritative resolution.

### P1-02 — Resolved proposals can be used for fresh rolls (R2)

**Source:** `src/service/aiWorkflowService.ts:405-441`.

**Repro:** Resolve a proposal once; repeat with a **new action ID** and updated state version using the same `proposalId`.

**Observed:** second distinct roll succeeds (versions 1, 2). The proposal's `status` is updated but never checked before a new resolution.

**Fix:** Require `proposal.status='proposed'`, update status conditionally and check affected-row count within the same transaction, bind proposal to exactly one result action/pending action, and return the original result only on exact idempotent retry.

### P1-03 — Locked proposal does not lock skill or pending action binding (R3, R4)

**Source:** `src/service/aiWorkflowService.ts:405-464`.

**R3 repro:** Proposal for `Stealth`, then resolve using `Acrobatics` with the same DC/actor/ability.

**Observed:** Acrobatics was accepted. Only DC/ability/character are compared.

**R4 repro:** Proposal linked to pending action A, while resolution explicitly passes pending action B for the same player.

**Observed:** B marked `resolved`, A remained `pending`.

**Fix:** Compare *all* proposal fields that influence the roll (skill, advantage, actor, DC, check type, linked pending intent); reject explicitly provided pending ID if it differs from the locked value. Require a valid pending intent for gameplay.

### P1-04 — Action idempotency still ignores `advantageMode` and pending linkage (R5)

**Source:** `src/service/commandService.ts:218-237, 649-677`.

**Repro:** Execute an ATTACK with `advantageMode='none'`; repeat using the same `actionId` but `advantageMode='advantage'`.

**Observed:** Returned `isDuplicate=true` instead of `ConflictError`.

**Fix:** Persist a canonical request payload/fingerprint including normalized advantage mode, weapon, actor, target, and pending-action association. Compare whole logical requests on retries. Do not compare only fields recoverable from result DTOs.

### P1-05 — Unrestricted mechanics remain callable through the MCP tool (R7, R8)

**Source:** `src/mcp/server.ts:320-390`, `src/service/commandService.ts:428-564, 629-647`.

**R7 repro:** Fighter with Speed 30 moves from `(2,5)` to `(8,5)` and then to `(14,5)` on two consecutive actions.

**Observed:** 60 ft cumulative movement accepted without a turn boundary or tracked movement budget. There is no wall/occupancy/path check.

**R8 repro:** Fighter submits an intent to investigate a door; DM resolves that pending intent by healing the Rogue with `100d100+999`, source “Potion of Healing”.

**Observed:** Pending intent consumed, healing applied to capped max HP, and Fighter inventory unchanged. `HEAL` / `APPLY_DAMAGE` have no actor/source resource validation, and `REST` has no time/resource precondition.

**Fix:** Until corresponding Phase 04 mechanics exist, disable or explicitly isolate these debug/stub commands from live MCP campaigns. Do not claim Movement, Rest, and Healing are authoritative D&D gameplay. Before enabling, add a combat turn/action budget, valid path and distance, real resource consumption, and actor/pending-action binding for every mutation.

### P1-06 — Proposal idempotency returns caller-modified data (R9)

**Source:** `src/service/aiWorkflowService.ts:297-313`.

**Repro:** Submit proposal ID `p1` for Rogue Stealth. Resubmit ID `p1` with the same DC/type but parameters changed to Fighter Perception.

**Observed:** No conflict; returns the **new caller-supplied proposal** even though the database still holds the original.

**Fix:** Compare canonical proposal body, including all parameters/explanation/citation and pending linkage. For exact retries, return the persisted proposal, never the untrusted new request.

### P2-01 — Origin protection is optional and disabled by default (R10)

**Source:** `src/transport/http.ts:38-68`, `src/index.ts:48-58`.

**Observed:** Listener with `remoteMode=true` and a valid token but no `allowedOrigins` responds to arbitrary Origin with `Access-Control-Allow-Origin: *`. CLI does not pass any configured trusted origin/host list.

**Risk qualifier:** Bearer authentication remains effective when correctly configured. A wildcard origin is not, by itself, an authentication bypass; however it fails the intended restrictive origin policy and broadens browser exposure of token-bearing clients.

**Fix:** Explicitly configure trusted origins/hosts for public deployment, disallow wildcard CORS when remote, and test the actual CLI deployment path.

### P2-02 — Payload-size bound bypassed by chunked requests (R11)

**Source:** `src/transport/http.ts:86-93, 112-121`.

**Repro:** `maxRequestBodyBytes=100`, POST >100 bytes using chunked transfer without `Content-Length`.

**Observed:** HTTP 400 from MCP JSON parsing, **not 413**. Request length guard checks only the optional `Content-Length` header.

**Fix:** Enforce actual streamed byte count with bounded reading/abort, plus reverse-proxy body limits where applicable.

### P2-03 — Deployment via tunnel still needs an explicit authentication checklist

**Source:** `src/transport/http.ts:18-34`, README remote setup instructions.

Fail-closed logic applies to non-loopback binds or explicit `remoteMode`. A public Cloudflare/ngrok tunnel may forward into `127.0.0.1` while the app does not know it is remotely accessible. If launched in default loopback mode with no token, the tunneled MCP endpoint will be unauthenticated.

**Fix:** Provide and document a distinct `start:remote` mode that strictly requires token/config; make tunnel recipes use only this mode; apply authentication at the proxy too where feasible. Validate authenticated remote MCP tools with the selected AI GUI before claiming real-host readiness.

### P2-04 — MVP fixtures/docs need cleanup before three-player rooms

`seedPocFixture` inserts four public player-role characters: legacy `hero-1` plus three Phase 01 premades. The standalone Scene Demo prints Hero + three premades. These are acceptable PoC fixtures, but a real campaign must have three assigned players, not an automatically exposed fourth.

The README quickstart mentions “18” tests while 58 `it(...)` cases are present. Update the status to distinguish author-reported Vitest passes from the review environment's unexecuted suite, and keep real cloud-host connectivity marked unverified.

## Phase 03 entry gate — recommended order

1. **P0 trust boundary:** sanitize/redact `get_event_log`, `get_game_state`, `get_game_context`, mutation results, and future player feeds. Add hidden actor/HP/AC regression tests.
2. **P1 resolution lock:** make live `proposalId` + linked pending action mandatory; bind skill, advantage, actor, and pending action; prevent proposal reuse and altered retries.
3. **P1 mutation contracts:** canonical payload fingerprints on all game events, including attack `advantageMode`, pending ID and type; stop unvalidated HEAL/REST/MOVE/DAMAGE from live host until supported.
4. **Network gate:** explicitly secured tunnel mode, origin/host policy, actual streamed payload limit; manual read/write MCP test in the **real AI GUI**.
5. **Regression suite:** rerun full Vitest on supported OS with a clean platform-local `npm ci`; run typecheck/build/smoke; add direct reproductions R1–R11 as automated tests.
6. **Then Phase 03:** separate player identities/auth, Room Code, 3-person browser UI, shared action queue and server-authorized Socket.IO views. Do not build map/combat complexity ahead of Phase 04.

## Handoff prompt

> Review this audit against current HEAD. Perform a **Phase 02.1 correctness/security hardening pass** only. Fix the concrete reproduced issues R1–R11 and the live-tool exposure gap, prioritizing spoiler-safe tool outputs and locked ability-check proposals. Use surgical changes, preserve the MCP-first/GameService/SQLite architecture, and add deterministic regression tests for each resolved issue. Then run `npm test`, `npm run typecheck`, `npm run build` and MCP client smoke checks on your machine, reporting exact observed results. Clearly distinguish in-process MCP smoke from real ChatGPT/Claude remote-host verification. Do not start Phase 03, frontend, map engine, RAG, or unrelated refactors. Stop for review when Phase 02.1 is complete.
