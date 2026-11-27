import { describe, expect, it } from 'vitest';
import { detectExitError } from '../../packages/core/src/run-observability/exit-code-detector.js';

describe('T8 exit nonzero cancelled skip', () => {
  it('returns null when cancelled is true', () => {
    const payload = detectExitError({
      runId: 'run-001',
      sessionId: 'sid-001',
      status: 'failed',
      cancelled: true,
      elapsedS: 42,
      exitMeta: { exit_code: 1, signal: 'SIGTERM' },
    });
    expect(payload).toBeNull();
  });

  it('returns null when status is not failed', () => {
    const payload = detectExitError({
      runId: 'run-001',
      sessionId: 'sid-001',
      status: 'succeeded',
      cancelled: false,
      elapsedS: 42,
      exitMeta: { exit_code: 1, signal: 'SIGTERM' },
    });
    expect(payload).toBeNull();
  });
});
