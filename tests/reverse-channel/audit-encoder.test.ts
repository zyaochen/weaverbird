import { describe, expect, it } from 'vitest';
import { REVERSE_CHANNEL_AUDIT_RESOURCE_PREFIX, REVERSE_CHANNEL_ERROR_CODES } from '../../packages/core/src/reverse-channel/contracts.js';
import { encodeAuditResource, redactSenderOpenId } from '../../packages/core/src/reverse-channel/audit-encoder.js';

describe('audit-encoder', () => {
  it('redacts sender open id to first 8 chars plus stars', () => {
    expect(redactSenderOpenId('ou_1234567890abcdef')).toBe('ou_12345***');
  });

  it('encodes pause audit resource in fixed format', () => {
    const resource = encodeAuditResource({
      verb: 'pause',
      targetId: 'run_abc123',
      senderOpenId: 'ou_1234567890abcdef',
      signal: 'SIGSTOP',
      result: 'ok',
    });
    expect(resource).toBe('reverse-channel:pause:run_abc123:sender=ou_12345***:sig=SIGSTOP:result=ok');
  });

  it('encodes failed cancel audit resource with reason code', () => {
    const resource = encodeAuditResource({
      verb: 'cancel',
      targetId: 'run_abc123',
      senderOpenId: 'ou_1234567890abcdef',
      signal: 'SIGTERM',
      result: 'fail',
      reasonCode: 'E_SIGNAL_FAILED',
    });
    expect(resource).toContain(`${REVERSE_CHANNEL_AUDIT_RESOURCE_PREFIX}cancel:run_abc123`);
    expect(resource).toContain('result=fail:reason=E_SIGNAL_FAILED');
  });

  it('returns raw when under limit', () => {
    const resource = encodeAuditResource({
      verb: 'pause',
      targetId: 'r1',
      senderOpenId: 'ou_1234567890abcdef',
      signal: 'SIGSTOP',
      result: 'ok',
    });
    expect(resource).toBe('reverse-channel:pause:r1:sender=ou_12345***:sig=SIGSTOP:result=ok');
  });

  it('drops reason first when over limit', () => {
    const resource = encodeAuditResource({
      verb: 'pause',
      targetId: 'r1',
      senderOpenId: 'ou_1234567890abcdef',
      signal: 'SIGSTOP',
      result: 'fail',
      reasonCode: (`E_SIGNAL_FAILED${'_'.repeat(300)}`) as keyof typeof REVERSE_CHANNEL_ERROR_CODES,
    });
    expect(resource).toContain('reverse-channel:pause:r1');
    expect(resource).toContain('sender=');
    expect(resource).toContain('sig=SIGSTOP');
    expect(resource).not.toContain('reason=');
    expect(resource.length).toBeLessThanOrEqual(256);
  });

  it('drops sig when reason already gone but still over limit', () => {
    const resource = encodeAuditResource({
      verb: 'pause',
      targetId: 'x'.repeat(210),
      senderOpenId: 'ou_1234567890abcdef',
      signal: 'SIGSTOP',
      result: 'fail',
      reasonCode: (`E_SIGNAL_FAILED${'_'.repeat(600)}`) as keyof typeof REVERSE_CHANNEL_ERROR_CODES,
    });
    expect(resource).not.toContain('reason=');
    expect(resource).not.toContain('sig=SIGSTOP');
    expect(resource).toContain('sender=');
    expect(resource.length).toBeLessThanOrEqual(256);
  });

  it('truncates targetId as last resort with ... suffix', () => {
    const resource = encodeAuditResource({
      verb: 'attach',
      targetId: 'x'.repeat(500),
      result: 'ok',
    });
    expect(resource.endsWith('...')).toBe(true);
    expect(resource.length).toBe(256);
  });
});
