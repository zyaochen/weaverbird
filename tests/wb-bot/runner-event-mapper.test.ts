import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../packages/core/src/agent/types.js';
import { EventsFileReader, runnerEventMapper } from '../../apps/wb-bot/src/feishu/events-file-reader.js';

// events.ndjson as wb-runner writes it: raw CLI stdout lines (+ schemaVersion), then its own terminal event.
const CLAUDE_LINES = [
  { type: 'system', subtype: 'init', cwd: '/tmp/p', session_id: 'sess-1', model: 'gpt-5.4', schemaVersion: 1 },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/tmp/p/a.png' } }] }, schemaVersion: 1 },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] }, schemaVersion: 1 },
  { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 10, schemaVersion: 1 },
  { type: 'assistant', message: { content: [{ type: 'text', text: '这是一个文件写入失败' }] }, schemaVersion: 1 },
  { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', total_cost_usd: 0.03, usage: { input_tokens: 1932, output_tokens: 910 }, schemaVersion: 1 },
  { type: 'done', schemaVersion: 1 },
];

describe('runnerEventMapper', () => {
  it('translates raw claude stream lines and passes the runner terminal event through', () => {
    const map = runnerEventMapper('claude-code', { cwd: '/tmp/p' });
    const events = CLAUDE_LINES.flatMap((line) => map(line));
    expect(events.map((event) => event.type)).toEqual(['system', 'tool_use', 'tool_result', 'text', 'usage', 'done', 'done']);
    expect(events.find((event) => event.type === 'text')).toMatchObject({ delta: '这是一个文件写入失败' });
    expect(events.find((event) => event.type === 'done')).toMatchObject({ continuationToken: 'sess-1' });
  });

  it('keeps wb-runner error events for claude', () => {
    const map = runnerEventMapper('claude-code', { cwd: '/tmp/p' });
    expect(map({ type: 'error', message: 'child exited with code 1', schemaVersion: 1 })).toEqual([
      { type: 'error', message: 'child exited with code 1', schemaVersion: 1 },
    ]);
  });

  it('translates raw codex exec --json lines', () => {
    const map = runnerEventMapper('codex', { cwd: '/tmp/p', model: 'gpt-5.3-codex' });
    const events = [
      { type: 'thread.started', thread_id: 'th-1' },
      { type: 'item.completed', item: { id: 'i0', type: 'error', message: 'Model metadata not found' } },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hi' } },
      { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } },
      { type: 'error', message: 'child exited with code 1' },
    ].flatMap((line) => map(line));
    expect(events[0]).toMatchObject({ type: 'system', continuationToken: 'th-1', model: 'gpt-5.3-codex' });
    expect(events.some((event) => event.type === 'text' && event.delta === 'hi')).toBe(true);
    expect(events.map((event) => event.type)).toContain('done');
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'child exited with code 1' });
  });

  it('passes events through unchanged for agents without a mapper', () => {
    const map = runnerEventMapper(undefined, { cwd: '/tmp/p' });
    const raw = { type: 'assistant', message: {} };
    expect(map(raw)).toEqual([raw]);
  });
});

describe('EventsFileReader with a mapper', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('emits mapped AgentEvents instead of raw CLI lines', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wb-events-reader-'));
    const path = join(dir, 'events.ndjson');
    writeFileSync(path, `${CLAUDE_LINES.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const reader = new EventsFileReader(path, 0, runnerEventMapper('claude-code', { cwd: '/tmp/p' }));
    reader.start();
    const seen: AgentEvent[] = [];
    try {
      for await (const event of reader.events()) {
        seen.push(event);
        if (event.type === 'done') break;
      }
    } finally {
      reader.stop();
    }
    expect(seen.map((event) => event.type)).toEqual(['system', 'tool_use', 'tool_result', 'text', 'usage', 'done']);
  });
});
