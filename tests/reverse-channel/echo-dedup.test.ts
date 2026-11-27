import { describe, expect, it, vi } from 'vitest';
import { EchoTailer } from '../../packages/core/src/reverse-channel/echo-tailer.js';

describe('echo-dedup', () => {
  it('deduplicates same run_id + status within 30s window', async () => {
    let now = 0;
    const sink = vi.fn().mockResolvedValue(undefined);
    const tailer = new EchoTailer(sink, { nowFn: () => now });
    const payload = {
      run_id: 'run-001',
      cmd: 'cmd',
      cwd: '/repo',
      created_at: '2026-06-07T00:00:00.000Z',
      status: 'active',
      session: { session_id: 'sid-001', home_group_id: 'grp-001' } as any,
      operator_open_id: 'ou_abc',
    };
    await tailer.onRunUpserted(payload);
    now = 10_000;
    const second = await tailer.onRunUpserted(payload);
    expect(second).toBe(false);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('allows same run_id after dedup window expires', async () => {
    let now = 0;
    const sink = vi.fn().mockResolvedValue(undefined);
    const tailer = new EchoTailer(sink, { nowFn: () => now });
    const payload = {
      run_id: 'run-001',
      cmd: 'cmd',
      cwd: '/repo',
      created_at: '2026-06-07T00:00:00.000Z',
      status: 'active',
      session: { session_id: 'sid-001', home_group_id: 'grp-001' } as any,
      operator_open_id: 'ou_abc',
    };
    await tailer.onRunUpserted(payload);
    now = 31_000;
    await tailer.onRunUpserted(payload);
    expect(sink).toHaveBeenCalledTimes(2);
  });
});
