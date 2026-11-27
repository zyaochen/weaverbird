import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WbRunner, STOP_POLL_INTERVAL_MS } from '../../packages/core/src/runner/wb-runner.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('A6 stop.signal polling', () => {
  it('detects stop.signal within 500ms polling interval and terminates child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bot-stop-'));
    roots.push(dir);

    const spec = {
      runId: 'run-stop-test',
      botId: 'default',
      agentId: 'test-agent',
      agentCommand: 'sleep',
      agentArgs: ['30'],
      cwd: dir,
      env: { PATH: process.env['PATH']! },
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'r1',
    };

    const runner = new WbRunner(dir, spec);
    const runPromise = runner.start();

    await new Promise((r) => setTimeout(r, 200));

    const runDir = join(dir, 'runs', 'default', 'run-stop-test');
    expect(existsSync(join(runDir, 'pid'))).toBe(true);
    expect(existsSync(join(runDir, 'status'))).toBe(true);

    writeFileSync(join(runDir, 'stop.signal'), JSON.stringify({
      issuedBy: 'self-button',
      issuedAt: new Date().toISOString(),
      reason: 'test stop',
    }));

    const startTime = Date.now();
    await runPromise;
    const elapsed = Date.now() - startTime;

    expect(elapsed).toBeLessThan(STOP_POLL_INTERVAL_MS + 2000);

    const { readFileSync } = await import('node:fs');
    const status = readFileSync(join(runDir, 'status'), 'utf8').trim();
    expect(status).toBe('stopped');
  });

  it('STOP_POLL_INTERVAL_MS is 500ms per spec', () => {
    expect(STOP_POLL_INTERVAL_MS).toBe(500);
  });
});
