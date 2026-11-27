import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
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

function makeSpec(dir: string, runId: string, agentArgs: string[], stdinInput?: string): RunSpec {
  const base: RunSpec = {
    runId,
    botId: 'default',
    agentId: 'codex',
    agentCommand: process.execPath,
    agentArgs,
    cwd: dir,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
    userOpenId: 'u1',
    threadId: 't1',
    sourceMessageId: 'm1',
    replyMessageId: 'r1',
  };
  return stdinInput !== undefined ? { ...base, stdinInput } : base;
}

// D1 hotfix · 验证 wb-runner 在 spec.stdinInput 存在时:
//   1. spawn grandchild 使 stdio[0]='pipe'
//   2. 把 stdinInput 写到 grandchild.stdin 然后 end
//   3. grandchild 在 stdin 读到 EOF 后, 写 JSON stream 到 stdout
//   4. events.ndjson 收到对应 JSON event
//
// 这是 wb-bot → codex 链路的核心断点 — 不修就卡 running 永远.
describe('D1 wb-runner stdinInput pipe (codex path)', () => {
  it('writes stdinInput to grandchild stdin and grandchild can echo it as JSON event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-runner-stdin-'));
    roots.push(dir);

    // Fake codex: 从 stdin 读 prompt, 然后输出 text event + done event
    const fakeCodexScript = `
      let buf = '';
      process.stdin.on('data', (d) => { buf += d.toString(); });
      process.stdin.on('end', () => {
        console.log(JSON.stringify({ type: 'text', delta: buf.trim() }));
        console.log(JSON.stringify({ type: 'done' }));
        process.exit(0);
      });
    `;

    const promptViaStdin = 'hello-from-d1-stdin';
    const spec = makeSpec(dir, 'run-stdin', ['-e', fakeCodexScript], `${promptViaStdin}\n`);
    const runner = new WbRunner(dir, spec);
    await runner.start();

    const runDir = join(dir, 'runs', 'default', 'run-stdin');
    const events = readEvents(runDir);
    expect(events.length).toBeGreaterThanOrEqual(2);

    const textEvent = events.find((e) => e['type'] === 'text');
    expect(textEvent).toBeDefined();
    expect(textEvent!['delta']).toBe(promptViaStdin);

    const last = events[events.length - 1]!;
    expect(last['type']).toBe('done');
    expect(readFileSync(join(runDir, 'status'), 'utf8').trim()).toBe('done');
  });

  it('claude-code default path (no stdinInput) still uses stdio[0]=ignore — grandchild reading stdin gets EOF immediately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-runner-noStdin-'));
    roots.push(dir);

    // 无 stdinInput 时 stdio[0]='ignore', grandchild 的 stdin 是 /dev/null,
    // 读 stdin 立即 EOF, buf 为空字符串, 输出 empty delta + done.
    const fakeScript = `
      let buf = '';
      process.stdin.on('data', (d) => { buf += d.toString(); });
      process.stdin.on('end', () => {
        console.log(JSON.stringify({ type: 'text', delta: '<no-stdin>' + buf }));
        console.log(JSON.stringify({ type: 'done' }));
        process.exit(0);
      });
    `;

    const spec = makeSpec(dir, 'run-nostdin', ['-e', fakeScript]); // 不传 stdinInput
    const runner = new WbRunner(dir, spec);
    await runner.start();

    const runDir = join(dir, 'runs', 'default', 'run-nostdin');
    const events = readEvents(runDir);
    const textEvent = events.find((e) => e['type'] === 'text');
    expect(textEvent).toBeDefined();
    expect(textEvent!['delta']).toBe('<no-stdin>'); // 没有从 parent 收到任何 stdin payload
  });

  it('stdinInput="" 空字符串也走 pipe 路径 (区别于 undefined 走 ignore)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-runner-emptystdin-'));
    roots.push(dir);

    const fakeScript = `
      let buf = '';
      process.stdin.on('data', (d) => { buf += d.toString(); });
      process.stdin.on('end', () => {
        console.log(JSON.stringify({ type: 'text', delta: 'len=' + buf.length }));
        console.log(JSON.stringify({ type: 'done' }));
        process.exit(0);
      });
    `;

    const spec = makeSpec(dir, 'run-emptystdin', ['-e', fakeScript], '');
    const runner = new WbRunner(dir, spec);
    await runner.start();

    const runDir = join(dir, 'runs', 'default', 'run-emptystdin');
    const events = readEvents(runDir);
    const textEvent = events.find((e) => e['type'] === 'text');
    expect(textEvent!['delta']).toBe('len=0'); // 收到空字符串然后 EOF
  });
});
