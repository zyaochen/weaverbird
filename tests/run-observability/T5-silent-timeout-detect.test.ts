import { describe, expect, it } from 'vitest';
import { ObservabilityStoreEntrySchema } from '../../packages/core/src/run-observability/contracts.js';
import { shouldAlertSilentTimeout } from '../../packages/core/src/run-observability/silent-timeout-detector.js';

function entry(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  });
}

describe('T5 silent timeout detect', () => {
  it('triggers when last output is older than timeout', () => {
    const result = shouldAlertSilentTimeout(entry(), {
      nowIso: '2026-06-10T00:05:01.000Z',
      silentTimeoutS: 300,
      storeExists: true,
    });
    expect(result).toBe(true);
  });

  it('does not trigger when alerted or finalized or cancelled', () => {
    expect(shouldAlertSilentTimeout(entry({ alerted: true }), {
      nowIso: '2026-06-10T00:05:01.000Z',
      silentTimeoutS: 300,
      storeExists: true,
    })).toBe(false);
    expect(shouldAlertSilentTimeout(entry({ finalized: true }), {
      nowIso: '2026-06-10T00:05:01.000Z',
      silentTimeoutS: 300,
      storeExists: true,
    })).toBe(false);
    expect(shouldAlertSilentTimeout(entry({ cancelled: true }), {
      nowIso: '2026-06-10T00:05:01.000Z',
      silentTimeoutS: 300,
      storeExists: true,
    })).toBe(false);
  });

  it('falls back to updated_at or created_at when stdout timestamp is missing', () => {
    expect(shouldAlertSilentTimeout(entry({ last_stdout_at: null, updated_at: '2026-06-10T00:00:00.000Z' }), {
      nowIso: '2026-06-10T00:05:01.000Z',
      silentTimeoutS: 300,
      storeExists: true,
    })).toBe(true);
    expect(shouldAlertSilentTimeout(entry({ last_stdout_at: null, created_at: '2026-06-10T00:00:00.000Z' }), {
      nowIso: '2026-06-10T00:05:01.000Z',
      silentTimeoutS: 300,
      storeExists: false,
    })).toBe(true);
  });
});
