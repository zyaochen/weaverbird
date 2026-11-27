import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapClaudeStreamEvent, mapConsentLevelToPermissionMode, parseToolProgressInterval } from '../packages/core/src/agent/claude-code.js';
import type { AgentEvent } from '../packages/core/src/index.js';

function loadFixture(name: string): AgentEvent[] {
  const path = new URL(`./fixtures/${name}`, import.meta.url);
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  return lines.flatMap((line) => mapClaudeStreamEvent(JSON.parse(line)));
}

describe('claude code mapping', () => {
  it('maps the success stream into agent events', () => {
    expect(loadFixture('claude-stream-1.jsonl')).toEqual([
      { type: 'system', continuationToken: 'session-1', cwd: '/tmp/project', model: 'gpt-5.4' },
      { type: 'thinking', delta: 'plan' },
      { type: 'text', delta: 'Hello' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'package.json' } },
      { type: 'tool_result', id: 'tool-1', output: 'done', isError: false },
      { type: 'usage', inputTokens: 10, outputTokens: 4, costUsd: 0.12 },
      { type: 'done', continuationToken: 'session-1' },
    ]);
  });

  it('maps error results into a recoverable error event', () => {
    expect(loadFixture('claude-stream-error.jsonl')).toEqual([
      { type: 'error', message: 'Rate limit exceeded', code: 'rate_limit', recoverable: true },
    ]);
  });

  it('maps consent levels to Claude permission modes', () => {
    expect(mapConsentLevelToPermissionMode('plan-only')).toBe('plan');
    expect(mapConsentLevelToPermissionMode('strict')).toBe('default');
    expect(mapConsentLevelToPermissionMode('normal')).toBe('default');
    expect(mapConsentLevelToPermissionMode('relaxed')).toBe('acceptEdits');
    expect(mapConsentLevelToPermissionMode('auto')).toBe('bypassPermissions');
  });

  describe('F2: subagentId emit', () => {
    it('emits subagentId on tool_use when isSidechain=true + agentId present', () => {
      const events = mapClaudeStreamEvent({
        type: 'assistant',
        agentId: 'a01425713ba8a2d36',
        isSidechain: true,
        message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/tmp' } }] },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'tool_use', id: 'tu-1', subagentId: 'a01425713ba8a2d36' });
    });

    it('emits subagentId on tool_result when isSidechain=true', () => {
      const events = mapClaudeStreamEvent({
        type: 'user',
        agentId: 'b0ff12345678',
        isSidechain: true,
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'tool_result', id: 'tu-1', subagentId: 'b0ff12345678' });
    });

    it('does NOT emit subagentId when isSidechain is absent', () => {
      const events = mapClaudeStreamEvent({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-2', name: 'Write', input: {} }] },
      });
      expect(events).toHaveLength(1);
      expect((events[0] as any).subagentId).toBeUndefined();
    });

    it('does NOT emit subagentId when isSidechain=false', () => {
      const events = mapClaudeStreamEvent({
        type: 'assistant',
        agentId: 'abc123',
        isSidechain: false,
        message: { content: [{ type: 'tool_use', id: 'tu-3', name: 'Bash', input: {} }] },
      });
      expect(events).toHaveLength(1);
      expect((events[0] as any).subagentId).toBeUndefined();
    });

    it('does NOT emit subagentId when agentId is missing but isSidechain=true', () => {
      const events = mapClaudeStreamEvent({
        type: 'assistant',
        isSidechain: true,
        message: { content: [{ type: 'tool_use', id: 'tu-4', name: 'Grep', input: {} }] },
      });
      expect(events).toHaveLength(1);
      expect((events[0] as any).subagentId).toBeUndefined();
    });
  });

  describe('F3: parseToolProgressInterval', () => {
    it('returns default 2000 for undefined', () => {
      expect(parseToolProgressInterval(undefined)).toBe(2000);
    });
    it('returns parsed value for valid env', () => {
      expect(parseToolProgressInterval('500')).toBe(500);
    });
    it('returns default for env below floor (100)', () => {
      expect(parseToolProgressInterval('50')).toBe(2000);
    });
    it('returns default for env above ceiling (60000)', () => {
      expect(parseToolProgressInterval('120000')).toBe(2000);
    });
    it('returns default for NaN', () => {
      expect(parseToolProgressInterval('abc')).toBe(2000);
    });
    it('accepts exact floor (100)', () => {
      expect(parseToolProgressInterval('100')).toBe(100);
    });
    it('accepts exact ceiling (60000)', () => {
      expect(parseToolProgressInterval('60000')).toBe(60000);
    });
  });
});
