import { describe, expect, it, vi } from 'vitest';
import { reverseAtAuditResource, sendControlSignal } from '../../packages/core/src/reverse-channel/ipc-control-handler.js';

describe('ipc-control-handler', () => {
  it('maps pause/resume/cancel to the expected POSIX signal', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    expect((await sendControlSignal('pause', 123)).signal).toBe('SIGSTOP');
    expect((await sendControlSignal('resume', 123)).signal).toBe('SIGCONT');
    expect((await sendControlSignal('cancel', 123)).signal).toBe('SIGTERM');
    killSpy.mockRestore();
  });

  it('throws with pid details when signal send fails', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });
    await expect(sendControlSignal('pause', 123)).rejects.toThrow(/pid 123/);
    killSpy.mockRestore();
  });

  it('encodes reverse-at audit resource using the fixed resource format', () => {
    const resource = reverseAtAuditResource({ command: 'pause', runId: 'run_abc123', senderOpenId: 'ou_1234567890', result: 'ok' });
    expect(resource).toBe('reverse-channel:pause:run_abc123:sender=ou_12345***:sig=SIGSTOP:result=ok');
  });

  it('encodes failed reverse-at audit resource with reason key', () => {
    const resource = reverseAtAuditResource({ command: 'cancel', runId: 'run_abc123', senderOpenId: 'ou_1234567890', result: 'fail', reasonCode: 'E_SIGNAL_FAILED' });
    expect(resource).toContain('result=fail:reason=E_SIGNAL_FAILED');
  });
});
