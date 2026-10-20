/**
 * Phase 02 standalone demo: one-operator AI-DM story scene flow using the
 * AI workflow service end-to-end against a persistent SQLite database.
 *
 * Sequence mirrors the DM_RUNBOOK contract:
 *   1. Read sanitized game context.
 *   2. Player submits free-form intent (queued).
 *   3. DM proposes a resolution (DC proposed BEFORE rolling).
 *   4. Server resolves the ability check authoritatively.
 *   5. DM publishes narration derived only from returned outcomes.
 */
import { initDatabase, POC_CAMPAIGN_ID } from '../src/persistence/database.js';
import { AiWorkflowService } from '../src/service/aiWorkflowService.js';
import { CryptoRng } from '../src/domain/rng.js';
import { rmSync } from 'node:fs';

async function runScene(): Promise<void> {
  try {
    rmSync('data/scene-demo.db', { force: true });
    rmSync('data/scene-demo.db-wal', { force: true });
    rmSync('data/scene-demo.db-shm', { force: true });
  } catch {}
  const db = initDatabase({ dbPath: 'data/scene-demo.db' });
  const svc = new AiWorkflowService(db, undefined, new CryptoRng());

  console.log('=== Phase 02: AI-DM Story Scene Demo ===\n');

  // 1. DM reads context
  const ctx = svc.getGameContext(POC_CAMPAIGN_ID);
  console.log(`[DM] Scene: ${ctx.scene.locationTh} (${ctx.scene.location})`);
  console.log(`[DM] Party: ${ctx.party.map((p) => p.name).join(', ')}`);
  console.log(`[DM] Pending actions: ${ctx.pendingActionCount}`);
  console.log(`[DM] Context version: ${ctx.stateVersion}\n`);

  // 2. Player intent queued
  const pending = svc.submitPlayerAction(
    POC_CAMPAIGN_ID,
    'char-rogue-1',
    'ฉันย่องเข้าไปในถ้ำเพื่อค้นหากับดัก (I sneak into the cave to search for traps)',
    'ABILITY_CHECK'
  );
  console.log(`[Player] Queued intent: ${pending.intentText}`);

  // 3. DM proposes resolution BEFORE rolling
  const ts = Date.now();
  const proposal = svc.proposeResolution({
    campaignId: POC_CAMPAIGN_ID,
    actionId: `scene-propose-${ts}`,
    pendingActionId: pending.id,
    proposedResolutionType: 'ABILITY_CHECK',
    proposedRuleCitation: 'PHB Ch.7: Dexterity (Stealth) check',
    dc: 12,
    parameters: { characterId: 'char-rogue-1', ability: 'dex' },
    explanation:
      'ตรวจกับดักต้องทอย Dexterity (Stealth) เทียบกับ DC 12 (SRD 5.2.1)',
  });
  console.log(`[DM] Proposed: ${proposal.explanation}\n`);

  // 4. Server resolves authoritatively, validating against locked proposal and consuming pending action atomically
  const check = svc.resolveAbilityCheck(
    { campaignId: POC_CAMPAIGN_ID, actionId: `scene-check-${ts}`, expectedVersion: ctx.stateVersion },
    {
      characterId: 'char-rogue-1',
      ability: 'dex',
      dc: 12,
      skill: 'Stealth',
      reason: 'Trap detection at cave entrance',
    },
    proposal.actionId,
    pending.id
  );
  console.log(
    `[Server] d20=${check.d20} + ${check.modifier} = ${check.total} vs DC ${check.dc} => ${check.isSuccess ? 'SUCCESS (สำเร็จ)' : 'FAILURE (ล้มเหลว)'}`
  );
  // 5. DM narrates only the returned outcome
  const narrationText = check.isSuccess
    ? 'วาเอลก้าวอย่างระมัดระวัง สายตาของเขาจับเงากับดักเชือกที่ซ่อนอยู่ท่ามกลางพุ่มหนามได้ทัน'
    : 'เสียงกรอบแกรบของใบไม้ใต้เท้าทำให้กับดักเชือกเด้งขึ้นรอบข้อเท้าของเขา';
  const narration = svc.publishNarration(
    { campaignId: POC_CAMPAIGN_ID, actionId: `scene-narr-${ts}`, expectedVersion: check.stateVersion },
    {
      text: check.isSuccess
        ? 'Vael steps carefully, spotting the hidden snare trap among the brambles.'
        : 'A dry leaf crunches and the snare trap springs around his ankle.',
      textTh: narrationText,
      speakerName: 'DM',
    }
  );
  console.log(`[DM Narration] ${narration.textTh}`);

  // 6. Queue cleared atomically, final state verified
  const remaining = svc.getPendingActions(POC_CAMPAIGN_ID);
  console.log(`\n[System] Remaining pending actions: ${remaining.length}`);
  console.log(`[System] Final state version: ${svc.getGameContext(POC_CAMPAIGN_ID).stateVersion}`);

  db.close();
  console.log('\n=== Scene complete. State persisted in data/scene-demo.db ===');
}

runScene().catch((err) => {
  console.error('Scene demo failed:', err);
  process.exit(1);
});
