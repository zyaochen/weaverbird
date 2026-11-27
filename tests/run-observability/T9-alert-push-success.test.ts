import { describe, expect, it, vi } from 'vitest';
import { AlertPayloadSchema } from '../../packages/core/src/run-observability/contracts.js';
import { pushAlert } from '../../packages/core/src/run-observability/alert-pusher.js';
import { renderAtUser } from '../../packages/core/src/run-observability/alert-card-renderer.js';

describe('T9 alert push success', () => {
  it('sends one card with operator mention and marks alerted', async () => {
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
    const onAlerted = vi.fn();
    await pushAlert(payload, {
      session: { session_id: 'sid-001', home_group_id: 'grp-001', operator: 'ou_abc12345', agent: 'claude-code' },
      dataDir: '/tmp',
      client: { sendMessage },
      alertEnabled: true,
      alreadyAlerted: false,
      onAlerted,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const firstCallJson = JSON.stringify(sendMessage.mock.calls[0] ?? []);
    expect(firstCallJson).toContain('<at id=\\"ou_abc12345\\"></at>');
    expect(onAlerted).toHaveBeenCalledTimes(1);
  });

  it('falls back to plain text mention when operator is not ou_ prefixed', () => {
    expect(renderAtUser('alice')).toBe('alice');
  });
});
