import { describe, expect, it, vi } from 'vitest';
import { ObservabilityStoreEntrySchema } from '../../packages/core/src/run-observability/contracts.js';
import { finalizeRun } from '../../packages/core/src/run-observability/finalizer.js';

function entry() {
  return ObservabilityStoreEntrySchema.parse({
    run_id: 'run-001',
    session_id: 'sid-001',
    status: 'failed',
    updated_at: '2026-06-10T00:00:00.000Z',
    last_stdout_at: '2026-06-10T00:00:00.000Z',
    origin_message_id: null,
    card_message_id: 'card-1',
    home_group_id: 'grp-001',
    created_at: '2026-06-10T00:00:00.000Z',
    alert_reason: null,
  });
}

describe('T13 finalize no origin message id', () => {
  it('sends top-level card when origin_message_id is null', async () => {
    const updateCard = vi.fn(async () => undefined);
    const replyCard = vi.fn(async () => undefined);
    const sendCard = vi.fn(async () => undefined);
    const ok = await finalizeRun(entry(), [], {
      client: { updateCard, replyCard, sendCard },
      dataDir: '/tmp',
      nowIso: '2026-06-10T00:10:00.000Z',
    });
    expect(ok).toBe(true);
    expect(updateCard).toHaveBeenCalledTimes(1);
    expect(replyCard).not.toHaveBeenCalled();
    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(sendCard).toHaveBeenCalledWith('grp-001', expect.any(Object));
  });
});
