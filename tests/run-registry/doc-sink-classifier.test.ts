import { describe, expect, it } from 'vitest';
import { buildDocBody, classifyDocSink, collectLongformText, sanitizeDocSinkText } from '../../packages/core/src/run-registry/index.js';
import type { AgentEvent } from '../../packages/core/src/agent/types.js';

function textEvent(delta: string): AgentEvent {
  return { type: 'text', delta };
}

describe('doc-sink-classifier', () => {
  it('collects only text events into the final body', () => {
    const text = collectLongformText([
      { type: 'system' },
      textEvent('hello '),
      { type: 'tool_result', id: 't1', output: 'ignored', isError: false },
      textEvent('world'),
    ]);
    expect(text).toBe('hello world');
  });

  it('sanitizes sensitive ids and token-like values', () => {
    const sanitized = sanitizeDocSinkText('ou_123456789 oc_abcdef123 tenant_access_token sk-secret api_key=abc');
    expect(sanitized).not.toContain('ou_123456789');
    expect(sanitized).not.toContain('oc_abcdef123');
    expect(sanitized).not.toContain('tenant_access_token');
    expect(sanitized).not.toContain('sk-secret');
    expect(sanitized).not.toContain('api_key=abc');
  });

  it('rejects diff-like output', () => {
    const result = classifyDocSink([
      textEvent('diff --git a/file b/file\n@@\n--- a/file\n+++ b/file\n+line'),
    ], 'run-001');
    expect(result.shouldSink).toBe(false);
    expect(result.reason).toBe('diff_like');
  });

  it('marks long prose as sink-worthy', () => {
    const paragraph = 'This is a long paragraph about incident analysis and remediation. '.repeat(30);
    const result = classifyDocSink([
      textEvent(`${paragraph}\n\n${paragraph}\n\n${paragraph}`),
    ], 'run-002');
    expect(result.shouldSink).toBe(true);
    expect(result.reason).toBe('longform');
    expect(result.title).toBe('Weaverbird Run run-002');
  });

  it('builds doc body with run id backlink header', () => {
    const body = buildDocBody('run-003', 'Summary paragraph');
    expect(body).toContain('<title>Weaverbird Run run-003</title>');
    expect(body).toContain('Run ID: run-003');
    expect(body).toContain('Summary paragraph');
  });
});
