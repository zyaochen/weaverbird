import { describe, expect, it } from 'vitest';
import { createClaudeStreamMapper } from '../packages/core/src/agent/claude-code.js';
import { runnerEventMapper } from '../apps/wb-bot/src/feishu/events-file-reader.js';
import type { AgentEvent } from '../packages/core/src/index.js';

const streamEvent = (event: Record<string, unknown>, parent: string | null = null) => ({
  type: 'stream_event',
  event,
  parent_tool_use_id: parent,
  session_id: 's1',
});
const delta = (kind: 'text' | 'thinking', text: string, parent: string | null = null) =>
  streamEvent({ type: 'content_block_delta', index: 0, delta: { type: `${kind}_delta`, [kind]: text } }, parent);
const messageStart = (id: string) => streamEvent({ type: 'message_start', message: { id, role: 'assistant', content: [] } });
const assistant = (id: string, content: unknown[], parent: string | null = null) => ({
  type: 'assistant',
  message: { id, role: 'assistant', content },
  parent_tool_use_id: parent,
  session_id: 's1',
});

// --include-partial-messages 的真实顺序: message_start → 若干 delta → 每个 block 结束后一条完整 assistant (同 id).
const partialRun = [
  { type: 'system', subtype: 'init', session_id: 's1' },
  messageStart('msg_1'),
  delta('thinking', '先想'),
  delta('thinking', '一想'),
  assistant('msg_1', [{ type: 'thinking', thinking: '先想一想' }]),
  delta('text', 'Go 的'),
  delta('text', '类型系统'),
  assistant('msg_1', [{ type: 'text', text: 'Go 的类型系统' }]),
  assistant('msg_1', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.go' } }]),
];

function collect(mapper: (raw: Record<string, unknown>) => AgentEvent[], lines: Array<Record<string, unknown>>): AgentEvent[] {
  return lines.flatMap((line) => mapper(line));
}

describe('claude partial message streaming', () => {
  it('emits text and thinking deltas as they arrive and does not repeat them from the full message', () => {
    const events = collect(createClaudeStreamMapper(), partialRun);
    expect(events.filter((e) => e.type === 'thinking')).toEqual([
      { type: 'thinking', delta: '先想' },
      { type: 'thinking', delta: '一想' },
    ]);
    expect(events.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', delta: 'Go 的' },
      { type: 'text', delta: '类型系统' },
    ]);
    expect(events.filter((e) => e.type === 'tool_use')).toHaveLength(1);
  });

  it('ignores subagent deltas but keeps their full messages on the existing path', () => {
    const events = collect(createClaudeStreamMapper(), [
      messageStart('msg_1'),
      delta('text', 'sub partial', 'toolu_task'),
      assistant('msg_sub', [{ type: 'text', text: 'sub full' }], 'toolu_task'),
    ]);
    expect(JSON.stringify(events)).not.toContain('sub partial');
  });

  it('still maps full messages when partial streaming is off', () => {
    const events = collect(createClaudeStreamMapper(), [assistant('msg_1', [{ type: 'text', text: 'whole answer' }])]);
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'whole answer' }]);
  });

  it('resets per message so the next turn is not filtered', () => {
    const mapper = createClaudeStreamMapper();
    collect(mapper, [messageStart('msg_1'), delta('text', 'a'), assistant('msg_1', [{ type: 'text', text: 'a' }])]);
    const next = collect(mapper, [assistant('msg_2', [{ type: 'text', text: 'b' }])]);
    expect(next.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'b' }]);
  });

  it('runnerEventMapper streams deltas for claude-code and passes the runner terminal events through', () => {
    const mapper = runnerEventMapper('claude-code', { cwd: '/tmp' });
    const events = collect(mapper, [...partialRun, { type: 'done', schemaVersion: 1 }]);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Go 的类型系统');
    expect(events.at(-1)?.type).toBe('done');
  });
});
