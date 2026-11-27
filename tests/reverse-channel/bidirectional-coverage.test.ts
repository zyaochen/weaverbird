import { describe, expect, it } from 'vitest';
import { COMMAND_CATALOG } from '../../packages/core/src/captain/index.js';
import { decodeAuditResource, encodeAuditResource, redactSenderOpenId } from '../../packages/core/src/reverse-channel/audit-encoder.js';

describe('bidirectional-coverage', () => {
  it('includes 4 new reverse-channel catalog entries', () => {
    expect(COMMAND_CATALOG['attach']?.belongs_to).toBe('cli');
    expect(COMMAND_CATALOG['pause-im']?.belongs_to).toBe('bot');
    expect(COMMAND_CATALOG['resume-im']?.belongs_to).toBe('bot');
    expect(COMMAND_CATALOG['cancel-im']?.belongs_to).toBe('bot');
  });

  it('attach is cli-only and reverse-at commands are hidden from help lists', () => {
    expect(COMMAND_CATALOG['attach']?.im_visible).toBe(false);
    expect(COMMAND_CATALOG['attach']?.cli_visible).toBe(true);
    expect(COMMAND_CATALOG['pause-im']?.im_visible).toBe(false);
    expect(COMMAND_CATALOG['resume-im']?.im_visible).toBe(false);
    expect(COMMAND_CATALOG['cancel-im']?.im_visible).toBe(false);
  });

  it('audit resource encoding is reversible enough for coverage assertions', () => {
    const sender = redactSenderOpenId('ou_1234567890abcdef');
    const verbs = [
      { verb: 'attach' as const, signal: undefined, targetId: 'session_abc123' },
      { verb: 'pause' as const, signal: 'SIGSTOP' as const, targetId: 'run_abc123' },
      { verb: 'resume' as const, signal: 'SIGCONT' as const, targetId: 'run_abc123' },
      { verb: 'cancel' as const, signal: 'SIGTERM' as const, targetId: 'run_abc123' },
    ];
    for (const item of verbs) {
      const resource = encodeAuditResource({ verb: item.verb, targetId: item.targetId, senderOpenId: 'ou_1234567890abcdef', signal: item.signal, result: 'ok', fromCaptainId: item.verb === 'attach' ? 'old-captain' : undefined });
      const decoded = decodeAuditResource(resource);
      expect(decoded.verb).toBe(item.verb);
      expect(decoded.targetId).toBe(item.targetId);
      if (item.signal) expect(decoded.sig).toBe(item.signal);
      if (item.verb !== 'attach') expect(decoded.sender).toBe(sender);
      expect(resource).toContain('result=ok');
    }
  });

  it('keeps resource length within 256 chars by truncating tail fields first', () => {
    const resource = encodeAuditResource({
      verb: 'cancel',
      targetId: 'r'.repeat(64),
      senderOpenId: 'ou_1234567890abcdef',
      signal: 'SIGTERM',
      result: 'fail',
      reasonCode: 'E_SIGNAL_FAILED',
    });
    expect(resource.length).toBeLessThanOrEqual(256);
    expect(resource).toContain('sender=ou_12345***');
    expect(resource).toContain('sig=SIGTERM');
  });
});
