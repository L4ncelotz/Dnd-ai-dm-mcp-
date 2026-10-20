import { describe, it, expect } from 'vitest';
import { initDatabase, POC_CAMPAIGN_ID } from '../src/persistence/database.js';
import { AiWorkflowService } from '../src/service/aiWorkflowService.js';
import { DeterministicRng } from '../src/domain/rng.js';
import { VersionConflictError } from '../src/service/gameService.js';

describe('AiWorkflowService (Phase 02)', () => {
  it('submits, lists, and consumes pending player actions', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const svc = new AiWorkflowService(db);

    const action = svc.submitPlayerAction(POC_CAMPAIGN_ID, 'char-fighter-1', 'I search the cave entrance for traps', 'SEARCH');
    expect(action.status).toBe('pending');

    const pending = svc.getPendingActions(POC_CAMPAIGN_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0].intentText).toBe('I search the cave entrance for traps');

    svc.consumePendingAction(POC_CAMPAIGN_ID, action.id);
    expect(svc.getPendingActions(POC_CAMPAIGN_ID)).toHaveLength(0);
    db.close();
  });

  it('returns sanitized game context that omits hidden secrets', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const svc = new AiWorkflowService(db);

    const ctx = svc.getGameContext(POC_CAMPAIGN_ID);
    expect(ctx.party.length).toBeGreaterThanOrEqual(3);
    expect(ctx.scene.location).toContain('Cragmaw');
    expect(ctx.scene.revealedClues).toHaveLength(1);

    const raw = JSON.stringify(ctx);
    expect(raw).not.toContain('trap-snare-1');
    expect(raw).not.toContain('Hidden Goblin Archer');
    db.close();
  });

  it('resolves an ability check with injected RNG and records event', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const rng = new DeterministicRng([15]);
    const svc = new AiWorkflowService(db, undefined, rng);

    const result = svc.resolveAbilityCheck(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'check-1', expectedVersion: 0 },
      { characterId: 'char-rogue-1', ability: 'dex', dc: 12, reason: 'Trap detection' }
    );

    // Rogue DEX 16 -> +3 mod; d20=15 -> total 18 >= 12
    expect(result.total).toBe(18);
    expect(result.isSuccess).toBe(true);
    expect(result.stateVersion).toBe(1);
    db.close();
  });

  it('publishes narration and enforces version guard', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const svc = new AiWorkflowService(db);

    const narration = svc.publishNarration(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'narr-1', expectedVersion: 0 },
      { text: 'The cave mouth yawns darkly before you.', textTh: 'ปากถ้ำมืดมิดเบิกกว้างรออยู่ตรงหน้า', speakerName: 'DM' }
    );
    expect(narration.stateVersion).toBe(1);

    expect(() =>
      svc.publishNarration(
        { campaignId: POC_CAMPAIGN_ID, actionId: 'narr-2', expectedVersion: 0 },
        { text: 'stale test' }
      )
    ).toThrow(VersionConflictError);
    db.close();
  });

  it('narration does not mutate character HP', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const svc = new AiWorkflowService(db);

    svc.publishNarration(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'narr-hp', expectedVersion: 0 },
      { text: 'Hero takes 50 damage and dies!' }
    );

    const hp = db.prepare('SELECT hp FROM characters WHERE id = ?').get('char-fighter-1') as { hp: number };
    expect(hp.hp).toBe(12);
    db.close();
  });

  it('resolveAction executes command and consumes pending action', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const rng = new DeterministicRng([14, 5]);
    const svc = new AiWorkflowService(db, undefined, rng);

    const pending = svc.submitPlayerAction(POC_CAMPAIGN_ID, 'char-fighter-1', 'I swing my longsword at the goblin', 'ATTACK');

    const result = svc.resolveAction(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'atk-1', expectedVersion: 0 },
      { type: 'ATTACK', attackerId: 'char-fighter-1', targetId: 'goblin-1', weaponId: 'longsword' },
      pending.id
    );

    expect(result.stateVersion).toBe(1);
    expect(svc.getPendingActions(POC_CAMPAIGN_ID)).toHaveLength(0);
    db.close();
  });

  it('idempotency: repeating narration with same actionId returns cached result', () => {
    const db = initDatabase({ dbPath: ':memory:' });
    const svc = new AiWorkflowService(db);

    const first = svc.publishNarration(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'idem-narr', expectedVersion: 0 },
      { text: 'Hello' }
    );
    const second = svc.publishNarration(
      { campaignId: POC_CAMPAIGN_ID, actionId: 'idem-narr', expectedVersion: 0 },
      { text: 'Hello' }
    );

    expect(first.isDuplicate).toBe(false);
    expect(second.isDuplicate).toBe(true);
    expect(second.text).toBe(first.text);
    db.close();
  });
});
