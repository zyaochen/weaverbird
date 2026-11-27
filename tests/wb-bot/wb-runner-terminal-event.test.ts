import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WbRunner, type RunSpec } from '../../packages/core/src/runner/wb-runner.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function readEvents(runDir: string): Array<Record<string, unknown>> {
  const path = join(runDir, 'events.ndjson');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function makeSpec(dir: string, runId: string, agentArgs: string[]): RunSpec {
  return {
    runId,
    botId: 'default',
    agentId: 'test-agent',
    agentCommand: process.execPath,
    agentArgs,
    cwd: dir,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
    userOpenId: 'u1',
    threadId: 't1',
    sourceMessageId: 'm1',
    replyMessageId: 'r1',
  };
}

// D0 hotfix: wb-runner 在所有 child 终止路径都必须 append 一个终态 event 到 events.ndjson,
// 否则 wb-bot for-await 永远不 break, activeSessions 留下 zombie entry.
describe('D0 wb-runner terminal-event fallback', () => {
  it('appends done event when child exits 0 without emitting terminal event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-runner-term-'));
    roots.push(dir);
    const spec = makeSpec(dir, 'run-zero', ['-e', 'process.exit(0)']);
    const runner = new WbRunner(dir, spec);
    await runner.start();

    const runDir = join(dir, 'runs', 'default', 'run-zero');
    const events = readEvents(runDir);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1]!;
    expect(last['type']).toBe('done');
    expect(last['schemaVersion']).toBe(1);
    expect(readFileSync(join(runDir, 'status'), 'utf8').trim()).toBe('done');
  });

  it('appends error event when child exits non-zero without emitting terminal event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-runner-term-'));
    roots.push(dir);
    const spec = makeSpec(dir, 'run-nonzero', ['-e', 'process.exit(42)']);
    const runner = new WbRunner(dir, spec);
    await runner.start();

    const runDir = join(dir, 'runs', 'default', 'run-nonzero');
    const events = readEvents(runDir);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1]!;
    expect(last['type']).toBe('error');
    expect(String(last['message'] ?? '')).toContain('42');
    expect(last['schemaVersion']).toBe(1);
    expect(readFileSync(join(runDir, 'status'), 'utf8').trim()).toBe('error');
  });

  it('appends "stopped by user" error event when stop.signal triggers child termination', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-runner-term-'));
    roots.push(dir);
    const spec = makeSpec(dir, 'run-stop', ['-e', 'setTimeout(() => process.exit(0), 30000)']);
    const runner = new WbRunner(dir, spec);
    const runPromise = runner.start();

    await new Promise((r) => setTimeout(r, 200));

    const runDir = join(dir, 'runs', 'default', 'run-stop');
    writeFileSync(join(runDir, 'stop.signal'), JSON.stringify({
      issuedBy: 'test',
      issuedAt: new Date().toISOString(),
      reason: 'test stop',
    }));

    await runPromise;

    const events = readEvents(runDir);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1]!;
    expect(last['type']).toBe('error');
    expect(String(last['message'] ?? '')).toContain('stopped by user');
    expect(last['schemaVersion']).toBe(1);
    expect(readFileSync(join(runDir, 'status'), 'utf8').trim()).toBe('stopped');
  });

  it('does not duplicate done event when child already emits done', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-runner-term-'));
    roots.push(dir);
    const spec = makeSpec(dir, 'run-childdone', [
      '-e',
      'console.log(JSON.stringify({type:"done",continuationToken:"abc"})); process.exit(0)',
    ]);
    const runner = new WbRunner(dir, spec);
    await runner.start();

    const runDir = join(dir, 'runs', 'default', 'run-childdone');
    const events = readEvents(runDir);
    const doneEvents = events.filter((e) => e['type'] === 'done');
    expect(doneEvents.length).toBe(1);
    // child-emitted done carries continuationToken; fallback would not.
    expect(doneEvents[0]!['continuationToken']).toBe('abc');
    expect(readFileSync(join(runDir, 'status'), 'utf8').trim()).toBe('done');
  });

  it('does not append extra terminal event when child already emits error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-runner-term-'));
    roots.push(dir);
    const spec = makeSpec(dir, 'run-childerr', [
      '-e',
      'console.log(JSON.stringify({type:"error",message:"agent boom"})); process.exit(2)',
    ]);
    const runner = new WbRunner(dir, spec);
    await runner.start();

    const runDir = join(dir, 'runs', 'default', 'run-childerr');
    const events = readEvents(runDir);
    const terminalEvents = events.filter(
      (e) => e['type'] === 'done' || e['type'] === 'error',
    );
    expect(terminalEvents.length).toBe(1);
    expect(terminalEvents[0]!['type']).toBe('error');
    expect(terminalEvents[0]!['message']).toBe('agent boom');
    expect(readFileSync(join(runDir, 'status'), 'utf8').trim()).toBe('error');
  });
});
