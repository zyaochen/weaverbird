import { describe, expect, it, vi } from 'vitest';
import { AlertPayloadSchema } from '../../packages/core/src/run-observability/contracts.js';
import { pushAlert } from '../../packages/core/src/run-observability/alert-pusher.js';

describe('T11 alert push idempotent', () => {
  it('does not send again when already alerted', async () => {
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
      session: { session_id: 'sid-001', home_group_id: 'grp-001', operator: 'ou_abc12345', agent: 'claude-code' },
      dataDir: '/tmp',
      client: { sendMessage },
      alertEnabled: true,
      alreadyAlerted: true,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
