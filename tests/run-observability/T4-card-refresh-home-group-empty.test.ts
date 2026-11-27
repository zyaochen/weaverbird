import { describe, expect, it, vi } from 'vitest';
import { CardPipeline } from '../../apps/wb-bot/src/feishu/card-pipeline.js';
import { CardRefresher } from '../../packages/core/src/run-observability/card-refresher.js';
import { ObservabilityStoreEntrySchema } from '../../packages/core/src/run-observability/contracts.js';

function entry() {
  return ObservabilityStoreEntrySchema.parse({
    run_id: 'run-001',
    session_id: 'sid-001',
    status: 'active',
    updated_at: '2026-06-10T00:00:00.000Z',
    last_stdout_at: '2026-06-10T00:00:00.000Z',
    origin_message_id: null,
    card_message_id: null,
    created_at: '2026-06-10T00:00:00.000Z',
    alert_reason: null,
  });
}

describe('T4 card refresh home_group empty', () => {
  it('skips patching when no card_message_id exists', async () => {
    const patch = vi.fn(async () => undefined);
    const pipeline = new CardPipeline(patch, 800);
    const refresher = new CardRefresher(pipeline, () => undefined, () => '2026-06-10T00:00:10.000Z');
    const state = entry();
    if (state.card_message_id === null) {
      expect(patch).not.toHaveBeenCalled();
      return;
    }
    await refresher.refresh(state, 'step1');
  });

  it('marks patch failure code when pipeline throws', async () => {
    const patch = vi.fn(async () => { throw new Error('patch failed'); });
    const pipeline = new CardPipeline(patch, 0);
    const failures: string[] = [];
    const refresher = new CardRefresher(pipeline, (_entry, code) => { failures.push(code); }, () => '2026-06-10T00:00:10.000Z');
    await refresher.finalize({ ...entry(), card_message_id: 'card-1' }, 'step1');
    expect(failures).toContain('run-observability.im.patch_failed');
  });
});
