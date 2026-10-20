# Dnd-ai-dm-mcp-: Static Code Audit

Date: 2026-10-20
Repository: https://github.com/L4ncelotz/Dnd-ai-dm-mcp-
Branch inspected: `main` through public GitHub raw files.
Scope: source-level review of Phase 00-02 and readiness to begin Phase 03.

## Audit limitations

- This is a **static review**, not a verified test execution.
- Git clone failed in the review environment because `github.com` could not be resolved. `npm test`, `npm run typecheck`, and live AI-GUI integration were NOT executed by the reviewer.
- Findings below are grounded in source available on GitHub during this review. Reconfirm against your local HEAD before making edits.

## Assessment

**Recommendation: Do not start Phase 03 before a focused Phase 02 hardening pass.**

The project has meaningful foundations: official MCP v2 tool registration, SQLite state persistence, `BEGIN IMMEDIATE` writes, version checks, server-side crypto RNG, and a basic Thai narrative workflow. Several core contracts do not yet meet the stated Phase 02 trust and correctness requirements.

## Findings, in priority order

### P0-01: HTTP MCP endpoint can be unauthenticated when published

Source: `src/transport/http.ts`, lines 19-51, and `src/index.ts`, lines 11-29.

`MCP_AUTH_TOKEN` is optional. If not configured, request handling proceeds without any authentication; all MCP mutation tools become reachable by whoever can access the endpoint. CORS is wildcard and no trusted Origin check is visible. `/health` may remain an intentionally unauthenticated endpoint; MCP write tools should not.

**Fix:** Fail closed when HTTP binds to a non-loopback address or when a remote deployment flag is set. Require authenticated MCP requests and check trusted Origins/Host according to MCP transport security guidance. Bound request sizes and avoid returning internal exception detail. Do not expose the endpoint publicly until these controls are tested.

**Regression tests:** Remote mode without credentials refuses startup; missing/invalid credentials return 401; valid credentials work; disallowed Origin is rejected; local development behavior remains explicit.

### P1-01: Ability-check resolution is NOT exposed as an MCP tool

Source: `src/mcp/server.ts`, lines 204-365, `src/service/aiWorkflowService.ts`, lines 235-318, and `scripts/scene-demo.ts`, lines 33-59.

The server registers `propose_resolution` and `resolve_action`, but the latter only accepts ATTACK, HEAL, APPLY_DAMAGE, MOVE, REST. There is no MCP `resolve_ability_check` tool despite the service implementing `resolveAbilityCheck()`. The scene demo bypasses MCP and calls the service directly. As a result, the advertised AI-GUI ability-check story flow cannot be completed by those public tools alone.

**Fix:** Add a bounded, properly authorized ability-check MCP contract and a real MCP client integration test. Keep the ability/skill rules scoped to the actually supported subset.

**Regression test:** MCP client calls propose/check/publish end to end using only registered tools.

### P1-02: Resolution proposal / DC is not persisted or locked

Source: `src/service/aiWorkflowService.ts`, lines 320-330 and 235-298.

`proposeResolution()` validates a few fields and echoes the proposal without storing it. `resolveAbilityCheck()` accepts a fresh DC from the caller with no link to an approved proposal. It is possible to change the DC after a result is known, violating the stated design invariant.

**Fix:** Persist an immutable resolution proposal (DC, check type, actor, pending action ID, relevant skill/ability, state version) before rolling; resolution must reference its locked proposal and fail on mismatch or reuse.

**Regression tests:** Changed DC/actor after proposal is rejected; repeated resolution is idempotent; proposal survives restart; proposal linked to a different pending action is rejected.

### P1-03: Pending-action completion is non-atomic and unvalidated

Source: `src/service/aiWorkflowService.ts`, lines 129-139 and 332-346.

`resolveAction()` commits `executeCommand()` and only then updates the pending action separately. `consumePendingAction()` does not check `status='pending'` or verify exactly one row was updated. A nonexistent or previously resolved pending action can be submitted; retry with a new action ID risks double-application.

**Fix:** Resolve the linked pending action and the game mutation in the same transaction. Assert campaign ID, character/actor relationship, allowed status, and exactly one transition. Reject reuse of a consumed pending ID even with a new action ID. Keep an explicit separate pathway for system-generated actions if needed.

**Regression tests:** Missing/consumed/cross-campaign pending IDs rejected without state change; injected failure after mutation rolls back both; different action ID cannot reprocess same pending action.

### P1-04: Idempotency checks do not compare the full logical request

Source: `src/service/commandService.ts`, lines 201-220; `src/service/aiWorkflowService.ts`, lines 243-253 and 362-372.

For generic commands, duplicate `actionId` checks compare only command type, not target, amount formula, weapon, advantage mode or other arguments. Ability checks and narration return any event with a duplicate ID as if it had the requested shape. This can return incorrect results and obscure intent mismatches.

**Fix:** Store canonical action type and canonicalized request payload or a request fingerprint. On retry, verify an exact logical request match before returning the stored result. Different event types or payloads must return Conflict; exact duplicates return the original response.

**Regression tests:** Same ID with changed target, heal amount, movement destination, or event type conflicts; exact retry leaves one event and one mutation.

### P1-05: Hidden entity projection depends on ID-prefix conventions

Source: `src/service/aiWorkflowService.ts`, lines 174-196; `src/service/gameService.ts`, lines 90-105 and 248-269.

The `getGameContext()` projection categorizes anything with IDs starting with `goblin` or `monster` as a visible enemy and puts all other characters into the party. `get_game_state()` returns all rows in `characters` without a visibility filter. `get_event_log()` returns raw event payloads without an audience projection. The current fixture stores concealed encounters in scene JSON, but once concealed actors are placed into character/event tables, these paths can disclose them.

**Fix:** Replace ID-derived visibility with explicit typed ownership/visibility and server-controlled reveal state. Define a single authorized projection reused across MCP and future Web API surfaces; distinguish party, NPC, visible enemy and hidden enemy. Never send hidden facts in MCP errors, tool outputs or logs.

**Regression tests:** Hidden character/trap/NPC does not appear in any tool output or error until an authorized reveal; character-scoped discoveries do not leak to other players.

### P1-06: Unrestricted mechanical commands are exposed as authoritative

Source: `src/mcp/server.ts`, lines 254-323, and `src/service/commandService.ts`, lines 390-510.

`MOVE` accepts arbitrary integer coordinates with no range, obstacle, turn, grid or speed checks. `HEAL` and `APPLY_DAMAGE` accept free-form dice formula and source from the AI without requiring a verified resource or event. `REST` can be repeatedly requested without rest preconditions. These are reasonable stub mechanics during early development, but not yet authoritative D&D rules or safe player-driven commands.

**Fix:** Either scope these tools explicitly as test-only and keep them disabled in live campaigns or implement their applicable minimum preconditions before exposing Phase 03 actions. Do not attempt the full map/spell engine prematurely.

**Regression tests:** Arbitrary teleports, unsupported healing, unearned rest, and resource-free damage do not mutate a live campaign.

### P2-01: Skill check ignores proficiency and expertise

Source: `src/service/aiWorkflowService.ts`, lines 265-297; `src/domain/character.ts`, lines 35-51.

The resolver uses only the ability modifier, even when the request contains a `skill`. D&D 2024 applies proficiency (or Expertise, where appropriate). Current `CharacterSheet` does not model skill proficiencies.

**Fix:** Either document this as ability-score-only check and avoid claiming skill-check support, or model relevant character proficiencies and calculate the correct check modifier.

### P2-02: Critical hits double only the first damage-dice term

Source: `src/service/commandService.ts`, lines 338-349.

The regex replacement has no global flag. For composite damage `1d8+1d6+2`, only `1d8` is doubled; D&D 2024 critical hits roll all of the attack's damage dice twice.

**Fix:** Double every dice term (without doubling fixed modifiers) and add a regression for composite dice expressions.

### P2-03: Minimum attack damage uses 1 instead of 0

Source: `src/service/commandService.ts`, line 350, and `src/domain/rules.ts`, line 57.

The rules allow a damage roll to be reduced to 0 by a penalty, but not below 0. `Math.max(1, ...)` incorrectly forces at least 1 damage on a hit.

**Fix:** Use the correct nonnegative floor for damage; separately model any specific features that mandate minimum damage.

Official rules: https://www.dndbeyond.com/sources/dnd/br-2024/playing-the-game

### P2-04: Event log limit returns oldest entries, not latest

Source: `src/service/gameService.ts`, lines 248-269.

The query orders `state_version ASC LIMIT ?`; on a campaign with more than 50 events the default log omits recent actions, making recap/recovery less useful.

**Fix:** Query most recent N descending, then reverse in application code when chronological ordering is desired; add cursor pagination for history later.

### P2-05: Error responses expose internal exception messages

Source: `src/mcp/server.ts`, lines 369-402, and `src/transport/http.ts`, lines 89-95.

The code says not to leak internals but includes `err.message` in unknown MCP failures and HTTP 500 `detail`. Errors may carry file paths or implementation details.

**Fix:** Return opaque public errors with correlation IDs; log detailed errors server-side with secret redaction.

### P2-06: Docs overstate or contradict readiness

Sources: `README.md`, `docs/ROADMAP.md`, `docs/DM_RUNBOOK.md`, `docs/PHASE_00_POC.md`.

README claims Phase 00-02 implemented and verified, while runbook states real AI-GUI host connection is still blocked. Phase 00 document remains marked TODO. Keep a truthful status matrix distinguishing local MCP smoke, local in-process demo, tests reported by author, and live ChatGPT/Claude host validation.

## Positive observations

- Official MCP v2 server and tool schemas are used: `src/mcp/server.ts`.
- SQLite transactions, state version guards, and event storage are present in game/command services.
- Production dice use `crypto.randomInt` and tests can inject deterministic RNG: `src/domain/rng.ts`.
- `getGameContext()` intentionally avoids the `secret_traps_json` and `secret_enemies_json` fields of the current scene fixture.
- AI narration is persisted separately from numerical game mutations.
- Target separation of MCP adapter and game services is appropriate for adding a future shared web client.

## Recommended execution order

1. **Connectivity/security gate:** Real host entitlement + secured remote MCP read/write smoke test; fail closed for remote HTTP.
2. **Phase 02 workflow blockers:** Expose ability-check tool; persist/lock proposals; join pending state transitions to game transaction.
3. **Idempotency:** Compare complete logical request on every event path.
4. **Visibility:** Introduce explicit projection rules before Web/API exposing state to multiple players.
5. **Rules correctness:** Ability proficiency, critical composite dice, zero-damage floor; explicitly classify unimplemented movement/rest/resource preconditions.
6. **Tests and status:** Unit, integration, real MCP client and host smoke; update docs only after evidence exists.
7. Start Phase 03 only after the above correctness and secrecy gates pass.

## Agent handoff request

Please review these specific findings against current local HEAD. Fix only confirmed Phase 00-02 correctness, security, and trust-boundary bugs. Do not begin Phase 03, frontend, map UI, RAG, spells, or unrelated refactors. For each fix: name root cause, targeted code edits, regression tests, and actual `npm test`, `npm run typecheck`, `npm run build`, and MCP smoke results. Distinguish local test from real AI-GUI integration. If a fix requires a future phase (e.g., full map rules), document and enforce a clearly restricted stub rather than claiming feature completeness.
