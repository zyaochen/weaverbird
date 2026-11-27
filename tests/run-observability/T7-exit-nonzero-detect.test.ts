import { describe, expect, it } from 'vitest';
import { detectExitError } from '../../packages/core/src/run-observability/exit-code-detector.js';

describe('T7 exit nonzero detect', () => {
  it('produces exit_nonzero alert payload when status is failed and not cancelled', () => {
    const payload = detectExitError({
      runId: 'run-001',
      sessionId: 'sid-001',
      status: 'failed',
      cancelled: false,
      elapsedS: 42,
      exitMeta: { exit_code: 1, signal: 'SIGKILL' },
    });
    expect(payload).not.toBeNull();
    expect(payload?.reason).toBe('exit_nonzero');
    expect(payload?.exit_code).toBe(1);
    expect(payload?.signal).toBe('SIGKILL');
  });

  it('fills nullable exit meta fields with null when meta is omitted', () => {
    const payload = detectExitError({
      runId: 'run-001',
      sessionId: 'sid-001',
      status: 'failed',
      cancelled: false,
      elapsedS: 42,
    });
    expect(payload?.exit_code).toBeNull();
    expect(payload?.signal).toBeNull();
  });
});
