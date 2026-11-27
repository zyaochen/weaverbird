import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapCodexStreamEvent } from '../packages/core/src/agent/codex.js';
import type { AgentEvent } from '../packages/core/src/index.js';

function loadFixture(name: string): AgentEvent[] {
  const path = new URL(`./fixtures/${name}`, import.meta.url);
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  return lines.flatMap((line) => mapCodexStreamEvent(JSON.parse(line), { prompt: 'hello', cwd: '/tmp/project' }));
}

describe('codex mapping', () => {
  it('maps the success stream into agent events', () => {
    expect(loadFixture('codex-stream-1.jsonl')).toEqual([
      { type: 'system', continuationToken: 'codex-session-1', cwd: '/tmp/project', model: undefined },
      { type: 'tool_use', id: 'tool-1', name: 'shell', input: { command: 'ls -la' } },
      { type: 'tool_result', id: 'tool-1', output: 'file-a\nfile-b', isError: false },
      { type: 'text', delta: 'Hello from Codex' },
      { type: 'usage', inputTokens: 12, outputTokens: 7 },
      { type: 'done', continuationToken: 'codex-session-1' },
    ]);
  });

  it('maps error streams into auth errors', () => {
    expect(loadFixture('codex-stream-error.jsonl')).toEqual([
      { type: 'system', continuationToken: 'codex-session-err', cwd: '/tmp/project', model: undefined },
      { type: 'error', message: 'unexpected status 401 Unauthorized', code: 'auth', recoverable: false },
    ]);
  });
});
