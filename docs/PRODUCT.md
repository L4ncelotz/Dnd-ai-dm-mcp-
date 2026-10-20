# Product Requirements - Three-Player AI D&D Tabletop

Version 0.1 | 2026-10-20 | Intended for personal use by three friends.

## Problem statement

Three first-time D&D players have no human DM. Existing English-first tools fragment character creation, dice, battle maps and rules. An ordinary AI chat forgets HP, inventory, prior choices and spatial constraints. The group wants an affordable all-in-one Thai-first experience without players reading adventure spoilers.

## Users and roles

- Three players. Each owns one character and a browser session.
- One **AI-GUI operator** may relay group chat actions and press Continue. This is not a human DM role: no prep, private spoilers or adjudication expected.
- One AI host conversation acts as DM, calling approved MCP tools.
- The Game Server is the source of truth and owns concealed state.

## User experience

1. Create/join a private room with three players.
2. Choose a premade level-1 character (custom creation later).
3. See own sheet and the revealed map; interact in Thai.
4. State free-form intentions. In tactical combat, select explicit supported actions.
5. AI-GUI operator forwards/requests the next beat; host calls MCP and publishes narration into shared web.
6. Resume the same campaign after server and/or AI chat restart using canonical state.

## Product requirements (MVP after PoC)

| ID | Requirement | Acceptance |
|---|---|---|
| P01 | 3-player private room | Three distinct sessions join and see only authorized state. |
| P02 | Thai-first interface and narration | Core interaction is usable in Thai; optional English terminology. |
| P03 | Premade level-1 characters | Three sheets with fixed attributes/HP/AC/inventory. |
| P04 | Authoritative dice | Rolls recorded server-side with verifiable formula and result. |
| P05 | Basic combat | Turn order, simple move, attack, damage and end turn work without invented state. |
| P06 | Spatial engine | A 2D square grid with walls, movement/range checks, and basic visibility. |
| P07 | Server-held secrets | Undiscovered hidden data is absent from player and AI-GUI results. |
| P08 | Reliable persistence | Restart retains committed state and event history. |
| P09 | AI narration | AI cannot mutate game data via narration; it must call validated tools. |
| P10 | One-shot end-to-end | Three players finish and resume a bounded adventure. |

## Game and rules scope

- Rules baseline: legally usable SRD 5.2.1 content (revised 2024 rules); verify and cite the exact text for every rule implemented.
- Start from a constrained combat rules subset and premade characters whose abilities are fully supported.
- Do not label partial or house-rule behavior as fully compliant 2024 D&D.
- Do not use unexplained advantage, cover, stealth, concentration, or spells before they are implemented.
- AI may narrate any fictional intent, but if no supported mechanic resolves it, it must explain the limitation or route to a documented DM adjudication flow.

## Out of scope

- Long-form voice/TV-like DM autopilot; full 2024 classes, feats and spells; universal content from copyrighted books; random image art; 3D; paid LLM API calls; multi-model orchestration; public SaaS accounts.

## Quality constraints

- No silent state drift. Every state mutation has an event, version and idempotency key.
- No trusting client/LLM for damage totals or position legality.
- Explicit reconnect and failure behavior; understandable error message in Thai for players.
- Security by default: authenticated player actions, bounded input, no hidden fields in public API.
- Fail closed on unexpected/unimplemented rules.

## Open decisions (non-blocking for Phase 00)

- Final project name and branding.
- Exact AI-GUI host and workspace permissions (must be tested in Phase 00).
- Grid diagonal measurement and detailed 2024 combat policy (decide before implementing map).
- Whether operator speaks for the group via Discord or types each player's action.
