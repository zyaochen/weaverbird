import { describe, expect, it } from 'vitest';
import { ObservabilityStoreEntrySchema } from '../../packages/core/src/run-observability/contracts.js';
import { toggleAlert } from '../../packages/core/src/run-observability/obs-toggle-handler.js';

function entry() {
  return ObservabilityStoreEntrySchema.parse({
    run_id: 'run-001',
    session_id: 'sid-001',
    status: 'active',
    updated_at: '2026-06-10T00:00:00.000Z',
    last_stdout_at: null,
    origin_message_id: 'm1',
    card_message_id: 'card-1',
    created_at: '2026-06-10T00:00:00.000Z',
    alert_reason: null,
  });
}

describe('T16 obs on off toggle', () => {
  it('updates entry.alert_enabled and is idempotent', () => {
    const off = toggleAlert(entry(), false);
    expect(off.alert_enabled).toBe(false);
    const offAgain = toggleAlert(off, false);
    expect(offAgain.alert_enabled).toBe(false);
    const on = toggleAlert(offAgain, true);
    expect(on.alert_enabled).toBe(true);
  });
});
