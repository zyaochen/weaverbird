import { describe, expect, it, vi } from 'vitest';
import { EchoTailer } from '../../packages/core/src/reverse-channel/echo-tailer.js';

describe('echo-tailer', () => {
  it('sends echo payload through injected messageSink', async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const tailer = new EchoTailer(sink);
    const result = await tailer.onRunUpserted({
      run_id: 'run-001',
      cmd: 'claude-code do something',
      cwd: '/repo',
      created_at: '2026-06-07T00:00:00.000Z',
      status: 'active',
      session: { session_id: 'sid-001', home_group_id: 'grp-001' } as any,
      operator_open_id: 'ou_abc',
    });
    expect(result).toBe(true);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('skips echo when home_group_id is missing', async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const tailer = new EchoTailer(sink);
    const result = await tailer.onRunUpserted({
      run_id: 'run-001',
      cmd: 'claude-code do something',
      cwd: '/repo',
      created_at: '2026-06-07T00:00:00.000Z',
      status: 'active',
      session: { session_id: 'sid-001', home_group_id: '' } as any,
      operator_open_id: 'ou_abc',
    });
    expect(result).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });

  it('caps cmd_preview at 80 characters', async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const tailer = new EchoTailer(sink);
    await tailer.onRunUpserted({
      run_id: 'run-001',
      cmd: 'x'.repeat(120),
      cwd: '/repo',
      created_at: '2026-06-07T00:00:00.000Z',
      status: 'active',
      session: { session_id: 'sid-001', home_group_id: 'grp-001' } as any,
      operator_open_id: 'ou_abc',
    });
    expect((sink.mock.calls[0]?.[0] as { cmd_preview: string }).cmd_preview.length).toBe(80);
  });

  it('limits to at most 3 messages per run', async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    let now = 0;
    const tailer = new EchoTailer(sink, { nowFn: () => now });
    for (const [index, status] of ['active', 'failed', 'cancelled', 'succeeded'].entries()) {
      now = index * 31_000;
      await tailer.onRunUpserted({
        run_id: 'run-001',
        cmd: 'cmd',
        cwd: '/repo',
        created_at: '2026-06-07T00:00:00.000Z',
        status,
        session: { session_id: 'sid-001', home_group_id: 'grp-001' } as any,
        operator_open_id: 'ou_abc',
      });
    }
    expect(sink).toHaveBeenCalledTimes(3);
  });
});
