import { describe, expect, it, vi } from 'vitest';
import { ObservabilityStoreEntrySchema } from '../../packages/core/src/run-observability/contracts.js';
import { finalizeRun } from '../../packages/core/src/run-observability/finalizer.js';

function entry() {
  return ObservabilityStoreEntrySchema.parse({
    run_id: 'run-001',
    session_id: 'sid-001',
    status: 'succeeded',
    updated_at: '2026-06-10T00:00:00.000Z',
    last_stdout_at: '2026-06-10T00:00:00.000Z',
    origin_message_id: 'm1',
    card_message_id: 'card-1',
    home_group_id: 'grp-001',
    created_at: '2026-06-10T00:00:00.000Z',
    alert_reason: null,
  });
}

describe('T12 finalize basic', () => {
  it('updates old card first, then replies summary card and marks finalized', async () => {
    const calls: string[] = [];
    const updateCard = vi.fn(async () => { calls.push('update'); });
    const replyCard = vi.fn(async () => { calls.push('reply'); });
    const sendCard = vi.fn(async () => { calls.push('send'); });
    const onFinalized = vi.fn();
    const ok = await finalizeRun(entry(), ['line1', 'line2', 'line3'], {
      client: { updateCard, replyCard, sendCard },
      dataDir: '/tmp',
      nowIso: '2026-06-10T00:10:00.000Z',
      onFinalized,
    });
    expect(ok).toBe(true);
    expect(calls).toEqual(['update', 'reply']);
    expect(replyCard).toHaveBeenCalledTimes(1);
    expect(onFinalized).toHaveBeenCalledTimes(1);
  });

  it('does not finalize when updateCard fails', async () => {
    const updateCard = vi.fn(async () => { throw new Error('patch failed'); });
    const replyCard = vi.fn(async () => undefined);
    const sendCard = vi.fn(async () => undefined);
    const onFinalized = vi.fn();
    const ok = await finalizeRun(entry(), ['line1'], {
      client: { updateCard, replyCard, sendCard },
      dataDir: '/tmp',
      onFinalized,
    });
    expect(ok).toBe(false);
    expect(replyCard).not.toHaveBeenCalled();
    expect(onFinalized).not.toHaveBeenCalled();
  });
});
