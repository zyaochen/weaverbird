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
    origin_message_id: 'm1',
    card_message_id: 'card-1',
    created_at: '2026-06-10T00:00:00.000Z',
    alert_reason: null,
  });
}

describe('T3 card refresh rate limit', () => {
  it('uses CardPipeline to coalesce rapid refreshes into one patch', async () => {
    const patch = vi.fn(async () => undefined);
    const pipeline = new CardPipeline(patch, 800);
    const refresher = new CardRefresher(pipeline, () => undefined, () => '2026-06-10T00:00:10.000Z');
    const state = entry();
    await refresher.refresh(state, 'step1');
    await refresher.refresh({ ...state, step_index: 1 }, 'step2');
    await refresher.refresh({ ...state, step_index: 2 }, 'step3');
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('forces terminal card immediately', async () => {
    const patch = vi.fn(async () => undefined);
    const pipeline = new CardPipeline(patch, 800);
    const refresher = new CardRefresher(pipeline, () => undefined, () => '2026-06-10T00:00:10.000Z');
    await refresher.finalize({ ...entry(), status: 'succeeded' }, 'done');
    expect(patch).toHaveBeenCalledTimes(1);
  });
});
