import { describe, expect, it } from 'vitest';
import { EchoPayloadSchema as FrozenEchoPayloadSchema } from '../../packages/core/src/reverse-channel/contracts.js';
import {
  AlertPayloadSchema,
  FINALIZE_HEAD_LINES,
  FINALIZE_TAIL_LINES,
  ObservabilityConfigSchema,
  ObservabilityStoreEntrySchema,
  RunObservabilityError,
  RUN_OBSERVABILITY_ERROR_CODES,
  RunObservabilityEventSchema,
  EchoPayloadSchema,
} from '../../packages/core/src/run-observability/index.js';

describe('run-observability/contracts', () => {
  it('parses RunObservabilityEvent happy path', () => {
    const parsed = RunObservabilityEventSchema.parse({
      run_id: 'run-001',
      ts: '2026-06-09T00:00:00.000Z',
      line_index: 0,
      text: 'hello',
      source: 'stdout',
    });
    expect(parsed.truncated).toBe(false);
  });

  it('rejects RunObservabilityEvent with invalid source', () => {
    expect(() => RunObservabilityEventSchema.parse({
      run_id: 'run-001',
      ts: '2026-06-09T00:00:00.000Z',
      line_index: 0,
      text: 'hello',
      source: 'stdin',
    })).toThrow();
  });

  it('parses ObservabilityStoreEntry happy path', () => {
    const parsed = ObservabilityStoreEntrySchema.parse({
      run_id: 'run-001',
      session_id: 'sid-001',
      status: 'active',
      updated_at: '2026-06-09T00:00:00.000Z',
      last_stdout_at: null,
      origin_message_id: null,
      card_message_id: null,
      created_at: '2026-06-09T00:00:00.000Z',
      alert_reason: null,
    });
    expect(parsed.step_index).toBe(0);
    expect(parsed.alert_enabled).toBe(true);
    expect(parsed.home_group_id).toBeNull();
  });

  it('rejects ObservabilityStoreEntry when required field is missing', () => {
    expect(() => ObservabilityStoreEntrySchema.parse({
      run_id: 'run-001',
      session_id: 'sid-001',
    })).toThrow();
  });

  it('parses AlertPayload and Finalize config defaults', () => {
    const alert = AlertPayloadSchema.parse({
      run_id: 'run-001',
      session_id: 'sid-001',
      reason: 'silent_timeout',
      last_output_at: null,
      elapsed_s: 301,
      exit_code: null,
      signal: null,
    });
    expect(alert.reason).toBe('silent_timeout');
    const config = ObservabilityConfigSchema.parse({});
    expect(config.silent_timeout_s).toBe(300);
    expect(config.finalize_head_lines).toBe(FINALIZE_HEAD_LINES);
    expect(config.finalize_tail_lines).toBe(FINALIZE_TAIL_LINES);
  });

  it('rejects silent_timeout_s overrides outside bounds', () => {
    expect(() => ObservabilityConfigSchema.parse({ silent_timeout_s: 59 })).toThrow();
    expect(() => ObservabilityConfigSchema.parse({ silent_timeout_s: 1801 })).toThrow();
  });

  it('keeps error code set stable and re-exports frozen EchoPayloadSchema by identity', () => {
    expect(Object.keys(RUN_OBSERVABILITY_ERROR_CODES)).toEqual([
      'E_STORE_WRITE',
      'E_STORE_TRUNCATED',
      'E_IM_SEND_FAILED',
      'E_IM_PATCH_FAILED',
      'E_RUN_STALE_NOOP',
      'E_NO_ACTIVE_SESSION',
    ]);
    expect(EchoPayloadSchema).toBe(FrozenEchoPayloadSchema);
    const err = new RunObservabilityError(RUN_OBSERVABILITY_ERROR_CODES.E_STORE_WRITE, 'boom');
    expect(err.name).toBe('RunObservabilityError');
  });
});
