import { describe, expect, it } from 'vitest';
import type { AgentEvent, ConsentLevel, ErrorCode } from '../packages/core/src/index.js';

const consentLevels = ['plan-only', 'strict', 'normal', 'relaxed', 'auto'] satisfies readonly ConsentLevel[];
const errorCodes = ['auth', 'rate_limit', 'context_length', 'network', 'tool_failure', 'crashed'] satisfies readonly ErrorCode[];

function renderEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'system':
      return event.continuationToken ?? 'system';
    case 'text':
    case 'thinking':
      return event.delta;
    case 'tool_use':
      return `${event.name}:${event.id}`;
    case 'tool_progress':
      return `${event.id}:${event.message ?? ''}`;
    case 'tool_result':
      return `${event.id}:${event.output}`;
    case 'usage':
      return `${event.inputTokens ?? 0}/${event.outputTokens ?? 0}`;
    case 'consent_required':
      return event.id;
    case 'done':
      return event.continuationToken ?? 'done';
    case 'error':
      return event.message;
  }
}

describe('agent types', () => {
  it('defines the full consent and error enums', () => {
    expect(consentLevels).toEqual(['plan-only', 'strict', 'normal', 'relaxed', 'auto']);
    expect(errorCodes).toEqual(['auth', 'rate_limit', 'context_length', 'network', 'tool_failure', 'crashed']);
  });

  it('covers all ten agent event variants as a discriminated union', () => {
    const events: AgentEvent[] = [
      { type: 'system', continuationToken: 'session-1', cwd: '/tmp', model: 'opus' },
      { type: 'text', delta: 'hello' },
      { type: 'thinking', delta: 'plan' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'a.ts' } },
      { type: 'tool_progress', id: 'tool-1', message: 'running' },
      { type: 'tool_result', id: 'tool-1', output: 'ok', isError: false },
      { type: 'usage', inputTokens: 1, outputTokens: 2, costUsd: 0.3 },
      { type: 'consent_required', id: 'consent-1', operation: { kind: 'shell' } },
      { type: 'done', continuationToken: 'session-1' },
      { type: 'error', message: 'boom', code: 'crashed', recoverable: false },
    ];

    expect(events.map((event) => event.type)).toEqual([
      'system',
      'text',
      'thinking',
      'tool_use',
      'tool_progress',
      'tool_result',
      'usage',
      'consent_required',
      'done',
      'error',
    ]);
    expect(events.map(renderEvent)).toEqual([
      'session-1',
      'hello',
      'plan',
      'Read:tool-1',
      'tool-1:running',
      'tool-1:ok',
      '1/2',
      'consent-1',
      'session-1',
      'boom',
    ]);
  });
});
