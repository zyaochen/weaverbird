import { describe, expect, it } from 'vitest';
import {
  shouldPushOnDone,
  formatDurationHuman,
  formatCompletionMessage,
  parsePushThresholdMs,
} from '../../apps/wb-bot/src/feishu/completion-push.js';

describe('completion-push', () => {
  describe('shouldPushOnDone', () => {
    it('duration < threshold, no follow → false', () => {
      expect(shouldPushOnDone({ durationMs: 29_000, thresholdMs: 300_000, hasFollow: false })).toBe(false);
    });
    it('duration >= threshold, no follow → true', () => {
      expect(shouldPushOnDone({ durationMs: 300_000, thresholdMs: 300_000, hasFollow: false })).toBe(true);
    });
    it('duration < threshold, has follow → true', () => {
      expect(shouldPushOnDone({ durationMs: 10_000, thresholdMs: 300_000, hasFollow: true })).toBe(true);
    });
    it('threshold = 0, any duration → true', () => {
      expect(shouldPushOnDone({ durationMs: 100, thresholdMs: 0, hasFollow: false })).toBe(true);
    });
  });

  describe('formatDurationHuman', () => {
    it('42s', () => {
      expect(formatDurationHuman(42_000)).toBe('42s');
    });
    it('8m12s', () => {
      expect(formatDurationHuman(8 * 60_000 + 12_000)).toBe('8m12s');
    });
    it('8m (no seconds)', () => {
      expect(formatDurationHuman(8 * 60_000)).toBe('8m');
    });
    it('1h3m', () => {
      expect(formatDurationHuman(63 * 60_000)).toBe('1h3m');
    });
    it('1h (no minutes)', () => {
      expect(formatDurationHuman(60 * 60_000)).toBe('1h');
    });
  });

  describe('parsePushThresholdMs', () => {
    it('undefined → default', () => {
      expect(parsePushThresholdMs(undefined, 300_000)).toBe(300_000);
    });
    it('valid number string → parsed', () => {
      expect(parsePushThresholdMs('60000', 300_000)).toBe(60_000);
    });
    it('"0" → 0 (force all push)', () => {
      expect(parsePushThresholdMs('0', 300_000)).toBe(0);
    });
    it('"abc" → fallback default', () => {
      expect(parsePushThresholdMs('abc', 300_000)).toBe(300_000);
    });
    it('"-5" → fallback default', () => {
      expect(parsePushThresholdMs('-5', 300_000)).toBe(300_000);
    });
  });

  describe('formatCompletionMessage', () => {
    it('contains expected parts', () => {
      const msg = formatCompletionMessage('Claude Code', '/Users/test/code', 360_000);
      expect(msg).toContain('✅');
      expect(msg).toContain('Claude Code');
      expect(msg).toContain('6m');
      expect(msg).toContain('任务完成');
      // W2.5-Hotfix-batch-D D3: 用户面文本不再泄漏内部 AgentEvent type 字面值 'done'.
      expect(msg).not.toContain('done');
    });
  });
});
