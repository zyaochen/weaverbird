import { describe, expect, it, vi } from 'vitest';
import { AlertPayloadSchema, ObservabilityStoreEntrySchema } from '../../packages/core/src/run-observability/contracts.js';
import { pushAlert } from '../../packages/core/src/run-observability/alert-pusher.js';
import { finalizeRun } from '../../packages/core/src/run-observability/finalizer.js';

describe('T20 home group fallback', () => {
  it('skips alert send when home_group_id is empty and finalizer skips non-reply fallback too', async () => {
    const payload = AlertPayloadSchema.parse({
      run_id: 'run-001',
      session_id: 'sid-001',
      reason: 'silent_timeout',
      last_output_at: null,
      elapsed_s: 301,
      exit_code: null,
      signal: null,
    });
    const sendMessage = vi.fn(async () => undefined);
    await pushAlert(payload, {
      session: { session_id: 'sid-001', home_group_id: null, operator: 'ou_abc', agent: 'claude-code' },
      dataDir: '/tmp',
      client: { sendMessage },
      alertEnabled: true,
      alreadyAlerted: false,
    });
    expect(sendMessage).not.toHaveBeenCalled();

    const entry = ObservabilityStoreEntrySchema.parse({
      run_id: 'run-001',
      session_id: 'sid-001',
      status: 'failed',
      updated_at: '2026-06-10T00:00:00.000Z',
      last_stdout_at: null,
      origin_message_id: null,
      card_message_id: 'card-1',
      home_group_id: null,
      created_at: '2026-06-10T00:00:00.000Z',
      alert_reason: null,
    });
    const updateCard = vi.fn(async () => undefined);
    const replyCard = vi.fn(async () => undefined);
    const sendCard = vi.fn(async () => undefined);
    const ok = await finalizeRun(entry, [], {
      client: { updateCard, replyCard, sendCard },
      dataDir: '/tmp',
      nowIso: '2026-06-10T00:10:00.000Z',
    });
    expect(ok).toBe(true);
    expect(replyCard).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
  });
});
