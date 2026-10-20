import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { initDatabase, POC_CAMPAIGN_ID } from '../src/persistence/database.js';
import { GameService, ConflictError, NotFoundError, ValidationError } from '../src/service/gameService.js';
import { CommandService } from '../src/service/commandService.js';
import { AiWorkflowService } from '../src/service/aiWorkflowService.js';
import { startHttpServer } from '../src/transport/http.js';
import { createDndMcpServer } from '../src/mcp/server.js';
import { Client, InMemoryTransport as ClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DeterministicRng } from '../src/domain/rng.js';

describe('Phase 00-02 Hardening Audit Regression Suite', () => {
  const TEST_DB = 'data/test-hardening.db';

  beforeEach(() => {
    try {
      rmSync(TEST_DB, { force: true });
      rmSync(`${TEST_DB}-wal`, { force: true });
      rmSync(`${TEST_DB}-shm`, { force: true });
    } catch {}
  });

  afterEach(() => {
    try {
      rmSync(TEST_DB, { force: true });
      rmSync(`${TEST_DB}-wal`, { force: true });
      rmSync(`${TEST_DB}-shm`, { force: true });
    } catch {}
  });

  // ==========================================
  // P0-01 & P2-05: HTTP Transport Security & Safe Errors
  // ==========================================
  describe('P0-01 & P2-05: HTTP Transport Security & Redacted Errors', () => {
    it('refuses startup on non-loopback host without MCP_AUTH_TOKEN', async () => {
      const db = initDatabase({ dbPath: ':memory:' });
      const service = new GameService(db);

      await expect(
        startHttpServer({
          host: '0.0.0.0',
          port: 0,
          authToken: undefined,
          gameService: service,
        })
      ).rejects.toThrow(/Refusing to start HTTP MCP server on non-loopback interface/);

      db.close();
    });

    it('refuses startup in remoteMode without MCP_AUTH_TOKEN even on loopback', async () => {
      const db = initDatabase({ dbPath: ':memory:' });
      const service = new GameService(db);

      await expect(
        startHttpServer({
          host: '127.0.0.1',
          port: 0,
          remoteMode: true,
          authToken: undefined,
          gameService: service,
        })
      ).rejects.toThrow(/without MCP_AUTH_TOKEN configured/);

      db.close();
    });

    it('rejects disallowed Origin and Host with 403', async () => {
      const db = initDatabase({ dbPath: ':memory:' });
      const service = new GameService(db);
      const running = await startHttpServer({
        host: '127.0.0.1',
        port: 0,
        allowedOrigins: ['https://trusted-client.app'],
        allowedHosts: ['127.0.0.1'],
        gameService: service,
      });

      try {
        // Disallowed Origin -> 403
        const originRes = await fetch(`http://127.0.0.1:${running.port}/health`, {
          headers: { Origin: 'https://evil-attacker.com' },
        });
        expect(originRes.status).toBe(403);
        const originBody = (await originRes.json()) as { error: string };
        expect(originBody.error).toContain('Disallowed Origin');

        // Disallowed Host -> 403
        const hostRes = await fetch(`http://127.0.0.1:${running.port}/health`, {
          headers: { Host: 'evil-host.com' },
        });
        expect(hostRes.status).toBe(403);
      } finally {
        await running.close();
        db.close();
      }
    });

    it('rejects oversized request bodies with 413', async () => {
      const db = initDatabase({ dbPath: ':memory:' });
      const service = new GameService(db);
      const running = await startHttpServer({
        host: '127.0.0.1',
        port: 0,
        maxRequestBodyBytes: 100, // Small limit for testing
        gameService: service,
      });

      try {
        const largeBody = JSON.stringify({ data: 'x'.repeat(500) });
        const res = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': String(largeBody.length) },
          body: largeBody,
        });
        expect(res.status).toBe(413);
      } finally {
        await running.close();
        db.close();
      }
    });
  });

  // ==========================================
  // P1-01: Ability-Check Exposed as MCP Tool
  // ==========================================
  describe('P1-01: Ability-Check MCP Tool Integration', () => {
    it('executes resolve_ability_check end-to-end through official MCP client', async () => {
      const db = initDatabase({ dbPath: ':memory:' });
      const rng = new DeterministicRng([14]); // d20=14
      const gameService = new GameService(db, rng);
      const aiWorkflowService = new AiWorkflowService(db, undefined, rng);
      const server = createDndMcpServer({ gameService, aiWorkflowService });

      const [clientTransport, serverTransport] = ClientTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-mcp-client', version: '1.0.0' });
      await client.connect(clientTransport);

      // Verify tool listed
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('resolve_ability_check');

      // Execute resolve_ability_check via MCP
      const checkCall = await client.callTool({
        name: 'resolve_ability_check',
        arguments: {
          campaignId: POC_CAMPAIGN_ID,
          actionId: 'mcp-check-001',
          expectedVersion: 0,
          characterId: 'char-rogue-1',
          ability: 'dex',
          dc: 12,
          skill: 'Stealth',
          reason: 'Sneak past sleeping guards',
        },
      });

      expect(checkCall.isError).toBeFalsy();
      const content = checkCall.content as Array<{ text: string }>;
      const result = JSON.parse(content[0].text);
      expect(result.actionId).toBe('mcp-check-001');
      expect(result.d20).toBe(14);
      expect(result.modifier).toBe(7); // DEX 16 (+3) + Stealth Expertise (+4) = 7
      expect(result.total).toBe(21);
      expect(result.isSuccess).toBe(true);
      expect(result.stateVersion).toBe(1);

      await client.close();
      await server.close();
      db.close();
    });
  });

  // ==========================================
  // P1-02: Persisted and Locked Resolution Proposals
  // ==========================================
  describe('P1-02: Proposal Locking & Anti-Tampering', () => {
    it('locks DC in SQLite and rejects DC tampering after proposal', () => {
      const db = initDatabase({ dbPath: ':memory:' });
      const rng = new DeterministicRng([15]);
      const svc = new AiWorkflowService(db, undefined, rng);

      // 1. Propose resolution with DC 15
      const proposal = svc.proposeResolution({
        campaignId: POC_CAMPAIGN_ID,
        actionId: 'prop-lock-1',
        proposedResolutionType: 'ABILITY_CHECK',
        dc: 15,
        parameters: { characterId: 'char-rogue-1', ability: 'dex', skill: 'Stealth' },
        explanation: 'Stealth check DC 15',
      });

      // Verify stored in DB
      const stored = db.prepare('SELECT * FROM resolution_proposals WHERE id = ?').get('prop-lock-1') as {
        status: string;
        dc: number;
      };
      expect(stored.status).toBe('proposed');
      expect(stored.dc).toBe(15);

      // 2. Caller attempts to change DC to 10 when executing check -> ConflictError
      expect(() =>
        svc.resolveAbilityCheck(
          { campaignId: POC_CAMPAIGN_ID, actionId: 'check-tampered-1', expectedVersion: 0 },
          { characterId: 'char-rogue-1', ability: 'dex', dc: 10, skill: 'Stealth', reason: 'Sneak' },
          'prop-lock-1'
        )
      ).toThrow(ConflictError);

      // 3. Caller attempts to change character -> ConflictError
      expect(() =>
        svc.resolveAbilityCheck(
          { campaignId: POC_CAMPAIGN_ID, actionId: 'check-tampered-2', expectedVersion: 0 },
          { characterId: 'char-fighter-1', ability: 'dex', dc: 15, skill: 'Stealth', reason: 'Sneak' },
          'prop-lock-1'
        )
      ).toThrow(ConflictError);

      // 4. Executing with matching parameters succeeds and transitions proposal to 'resolved'
      const success = svc.resolveAbilityCheck(
        { campaignId: POC_CAMPAIGN_ID, actionId: 'check-valid-1', expectedVersion: 0 },
        { characterId: 'char-rogue-1', ability: 'dex', dc: 15, skill: 'Stealth', reason: 'Sneak' },
        'prop-lock-1'
      );
      expect(success.isSuccess).toBe(true);

      const resolved = db.prepare('SELECT status FROM resolution_proposals WHERE id = ?').get('prop-lock-1') as {
        status: string;
      };
      expect(resolved.status).toBe('resolved');

      db.close();
    });
  });

  // ==========================================
  // P1-03: Transactional Atomic Pending Action Consumption
  // ==========================================
  describe('P1-03: Atomic Pending Action Consumption', () => {
    it('validates pending action and consumes it atomically in transaction', () => {
      const db = initDatabase({ dbPath: ':memory:' });
      const rng = new DeterministicRng([14, 5]);
      const svc = new AiWorkflowService(db, undefined, rng);

      const pending = svc.submitPlayerAction(POC_CAMPAIGN_ID, 'char-fighter-1', 'Attack goblin');

      // 1. Resolve with invalid/missing pendingActionId throws NotFoundError
      expect(() =>
        svc.resolveAction(
          { campaignId: POC_CAMPAIGN_ID, actionId: 'act-missing-pending', expectedVersion: 0 },
          { type: 'ATTACK', attackerId: 'char-fighter-1', targetId: 'goblin-1' },
          'non-existent-pending-id'
        )
      ).toThrow(NotFoundError);

      // 2. Resolve with mismatched actor throws ValidationError
      expect(() =>
        svc.resolveAction(
          { campaignId: POC_CAMPAIGN_ID, actionId: 'act-mismatched-actor', expectedVersion: 0 },
          { type: 'ATTACK', attackerId: 'char-rogue-1', targetId: 'goblin-1' },
          pending.id
        )
      ).toThrow(ValidationError);

      // 3. Valid resolution consumes pending action
      svc.resolveAction(
        { campaignId: POC_CAMPAIGN_ID, actionId: 'act-valid-consume', expectedVersion: 0 },
        { type: 'ATTACK', attackerId: 'char-fighter-1', targetId: 'goblin-1' },
        pending.id
      );

      // Pending action is now 'resolved'
      expect(svc.getPendingActions(POC_CAMPAIGN_ID)).toHaveLength(0);

      // 4. Attempting to consume already-resolved pending action throws ConflictError
      expect(() =>
        svc.resolveAction(
          { campaignId: POC_CAMPAIGN_ID, actionId: 'act-double-consume', expectedVersion: 1 },
          { type: 'ATTACK', attackerId: 'char-fighter-1', targetId: 'goblin-1' },
          pending.id
        )
      ).toThrow(ConflictError);

      db.close();
    });
  });

  // ==========================================
  // P1-04: Strict Full-Request Idempotency
  // ==========================================
  describe('P1-04: Full Logical Request Idempotency', () => {
    it('rejects duplicate actionId with altered command arguments', () => {
      const db = initDatabase({ dbPath: ':memory:' });
      const rng = new DeterministicRng([12, 4]);
      const cmdSvc = new CommandService(db, rng);

      // Execute attack against goblin-1
      cmdSvc.executeCommand(
        { campaignId: POC_CAMPAIGN_ID, actionId: 'strict-idem-1', expectedVersion: 0 },
        { type: 'ATTACK', attackerId: 'char-fighter-1', targetId: 'goblin-1' }
      );

      // Reuse same actionId with altered targetId -> ConflictError
      expect(() =>
        cmdSvc.executeCommand(
          { campaignId: POC_CAMPAIGN_ID, actionId: 'strict-idem-1', expectedVersion: 0 },
          { type: 'ATTACK', attackerId: 'char-fighter-1', targetId: 'hero-1' }
        )
      ).toThrow(ConflictError);

      // Exact matching parameters -> returns duplicate commit without new event
      const duplicate = cmdSvc.executeCommand(
        { campaignId: POC_CAMPAIGN_ID, actionId: 'strict-idem-1', expectedVersion: 0 },
        { type: 'ATTACK', attackerId: 'char-fighter-1', targetId: 'goblin-1' }
      );
      expect(duplicate.isDuplicate).toBe(true);

      db.close();
    });

    it('rejects duplicate actionId in narration with altered text', () => {
      const db = initDatabase({ dbPath: ':memory:' });
      const svc = new AiWorkflowService(db);

      svc.publishNarration(
        { campaignId: POC_CAMPAIGN_ID, actionId: 'narr-strict-1', expectedVersion: 0 },
        { text: 'Initial text' }
      );

      expect(() =>
        svc.publishNarration(
          { campaignId: POC_CAMPAIGN_ID, actionId: 'narr-strict-1', expectedVersion: 0 },
          { text: 'Altered text' }
        )
      ).toThrow(ConflictError);

      db.close();
    });
  });

  // ==========================================
  // P1-05: Spoiler-Safe Visibility Projections
  // ==========================================
  describe('P1-05: Spoiler-Safe Visibility Projections', () => {
    it('completely excludes hidden entities from get_game_state and get_game_context', () => {
      const db = initDatabase({ dbPath: ':memory:' });
      const gameSvc = new GameService(db);
      const aiSvc = new AiWorkflowService(db);

      // 1. Check get_game_state: only public characters returned
      const gameState = gameSvc.getGameState(POC_CAMPAIGN_ID);
      const hiddenStateCharacter = gameState.characters.find((c) => c.id === 'goblin-ambush-1');
      expect(hiddenStateCharacter).toBeUndefined();

      // 2. Check get_game_context: hidden ambusher and secret traps are NOT returned
      const ctx = aiSvc.getGameContext(POC_CAMPAIGN_ID);
      const hiddenContextEnemy = ctx.visibleEnemies.find((e) => e.id === 'goblin-ambush-1');
      expect(hiddenContextEnemy).toBeUndefined();

      const rawJson = JSON.stringify(ctx);
      expect(rawJson).not.toContain('goblin-ambush-1');
      expect(rawJson).not.toContain('trap-snare-1');
      expect(rawJson).not.toContain('goblin-sniper-hidden');

      db.close();
    });
  });

  // ==========================================
  // P2-01: Skill Proficiencies and Expertise
  // ==========================================
  describe('P2-01: Skill Proficiency and Expertise', () => {
    it('applies proficiency (+2) and expertise (+4) correctly to checks', () => {
      const db = initDatabase({ dbPath: ':memory:' });
      // d20 = 10 for both rolls
      const rng = new DeterministicRng([10, 10]);
      const svc = new AiWorkflowService(db, undefined, rng);

      // 1. Rogue with DEX 16 (+3) and Stealth Expertise (+4) -> modifier = 7, total = 17
      const rogueCheck = svc.resolveAbilityCheck(
        { campaignId: POC_CAMPAIGN_ID, actionId: 'prof-check-rogue', expectedVersion: 0 },
        { characterId: 'char-rogue-1', ability: 'dex', dc: 15, skill: 'Stealth', reason: 'Hide' }
      );
      expect(rogueCheck.modifier).toBe(7);
      expect(rogueCheck.total).toBe(17);
      expect(rogueCheck.isSuccess).toBe(true);

      // 2. Fighter with DEX 12 (+1) and NO Stealth proficiency -> modifier = 1, total = 11
      const fighterCheck = svc.resolveAbilityCheck(
        { campaignId: POC_CAMPAIGN_ID, actionId: 'prof-check-fighter', expectedVersion: 1 },
        { characterId: 'char-fighter-1', ability: 'dex', dc: 15, skill: 'Stealth', reason: 'Hide' }
      );
      expect(fighterCheck.modifier).toBe(1);
      expect(fighterCheck.total).toBe(11);
      expect(fighterCheck.isSuccess).toBe(false);

      db.close();
    });
  });

  // ==========================================
  // P2-02: Critical Hit Doubles All Dice Terms
  // ==========================================
  describe('P2-02: Critical Hit Composite Dice Doubling', () => {
    it('doubles every dice term in composite damage formulas (e.g. 1d8+1d6+2 -> 2d8+2d6+2)', () => {
      const db = initDatabase({ dbPath: ':memory:' });
      // d20 = 20 (Critical hit!)
      // Composite weapon: 1d8 + 1d6 + 2
      // Doubled: 2d8 + 2d6 + 2
      // Dice rolls: 2d8 -> [6, 7] = 13; 2d6 -> [4, 5] = 9; + 2 = 24 damage
      const rng = new DeterministicRng([20, 6, 7, 4, 5]);
      const cmdSvc = new CommandService(db, rng);

      // Update longsword to composite damage 1d8+1d6+2
      db.prepare(
        "UPDATE characters SET attacks_json = ? WHERE id = 'char-fighter-1'"
      ).run(
        JSON.stringify([
          { id: 'composite-sword', name: 'Flaming Sword', nameTh: 'ดาบเพลิง', attackBonus: 5, damageFormula: '1d8+1d6+2', damageType: 'slashing' },
        ])
      );

      const result = cmdSvc.executeCommand(
        { campaignId: POC_CAMPAIGN_ID, actionId: 'crit-composite-1', expectedVersion: 0 },
        { type: 'ATTACK', attackerId: 'char-fighter-1', targetId: 'hero-1', weaponId: 'composite-sword' }
      );

      if ('attackRoll' in result) {
        expect(result.attackRoll.isCriticalHit).toBe(true);
        expect(result.damageRoll?.expression).toBe('2d8+2d6+2');
        expect(result.totalDamage).toBe(24);
      }

      db.close();
    });
  });

  // ==========================================
  // P2-03: Minimum Attack Damage Floor
  // ==========================================
  describe('P2-03: Minimum Damage Floor (0, not 1)', () => {
    it('allows damage to be reduced to 0 by negative modifier without forcing minimum 1', () => {
      const db = initDatabase({ dbPath: ':memory:' });
      // d20 = 15 (Hit)
      // Damage die d4 = 1, modifier -3 -> total damage = 1 - 3 = -2 -> clamped to 0
      const rng = new DeterministicRng([15, 1]);
      const cmdSvc = new CommandService(db, rng);

      db.prepare(
        "UPDATE characters SET attacks_json = ? WHERE id = 'char-fighter-1'"
      ).run(
        JSON.stringify([
          { id: 'feeble-dagger', name: 'Feeble Dagger', nameTh: 'มีดทื่อ', attackBonus: 5, damageFormula: '1d4-3', damageType: 'piercing' },
        ])
      );

      const result = cmdSvc.executeCommand(
        { campaignId: POC_CAMPAIGN_ID, actionId: 'min-damage-zero', expectedVersion: 0 },
        { type: 'ATTACK', attackerId: 'char-fighter-1', targetId: 'hero-1', weaponId: 'feeble-dagger' }
      );

      if ('totalDamage' in result) {
        expect(result.totalDamage).toBe(0);
        expect(result.targetHp).toBe(result.targetPreviousHp); // HP unchanged
      }

      db.close();
    });
  });

  // ==========================================
  // P2-04: Latest N Events in Event Log
  // ==========================================
  describe('P2-04: getEventLog Returns Latest N Events', () => {
    it('returns the most recent events in chronological order when count exceeds limit', () => {
      const db = initDatabase({ dbPath: ':memory:' });
      const gameSvc = new GameService(db);

      // Insert 10 events (versions 1 through 10)
      for (let v = 1; v <= 10; v++) {
        db.prepare(`
          INSERT INTO game_events (id, campaign_id, action_id, type, payload_json, state_version, created_at)
          VALUES (?, ?, ?, 'TEST_EVENT', ?, ?, ?)
        `).run(`evt-${v}`, POC_CAMPAIGN_ID, `act-${v}`, JSON.stringify({ seq: v }), v, new Date().toISOString());
      }

      // Query with limit 3: should return versions 8, 9, 10 (latest 3 in ascending order)
      const events = gameSvc.getEventLog(POC_CAMPAIGN_ID, 3);
      expect(events).toHaveLength(3);
      expect(events[0].stateVersion).toBe(8);
      expect(events[1].stateVersion).toBe(9);
      expect(events[2].stateVersion).toBe(10);

      db.close();
    });
  });
});
