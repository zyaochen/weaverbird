import { describe, expect, it } from 'vitest';
import { CaptainService } from '../../packages/core/src/captain/index.js';
import { parseReverseAt, validateReverseAtRun } from '../../packages/core/src/reverse-channel/reverse-at-handler.js';

describe('reverse-at-handler', () => {
  it('parses pause/resume/cancel commands with whitespace tolerance and case insensitivity', () => {
    expect(parseReverseAt('  Pause run_abc123  ', 'ou_abc', 'm1')?.command).toBe('pause');
    expect(parseReverseAt('resume run_abc123', 'ou_abc', 'm1')?.run_id).toBe('run_abc123');
    expect(parseReverseAt('CANCEL run_abc123', 'ou_abc', 'm1')?.command).toBe('cancel');
  });

  it('returns null for invalid syntax', () => {
    expect(parseReverseAt('@wb pause run_abc123', 'ou_abc', 'm1')).toBeNull();
    expect(parseReverseAt('pause "run_abc123"', 'ou_abc', 'm1')).toBeNull();
  });

  it('throws when run_id is not found in captain service', () => {
    const service = new CaptainService({ dataDir: '/tmp' });
    expect(() => validateReverseAtRun(service, 'run-missing')).toThrow();
  });

  it('accepts known run_id from active sessions', () => {
    const service = new CaptainService({ dataDir: '/tmp' });
    service.createSession({ session_id: 'sid-001', captain_id: 'default', created_at: '2026-06-07T00:00:00.000Z', last_active_at: '2026-06-07T00:00:00.000Z', cwd: '/repo', scope: 'dev', project: 'weaverbird', home_group_id: 'grp', agent: 'claude-code', latest_run_id: null, operator: 'ou_abc', entry_form: 'im' });
    service.bindRun('sid-001', 'run_abc123');
    expect(() => validateReverseAtRun(service, 'run_abc123')).not.toThrow();
  });
});
