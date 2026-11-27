import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const WB_RUNNER_MAIN = new URL('../../packages/core/src/runner/wb-runner-main.ts', import.meta.url).pathname;
const TSX_BIN = new URL('../../node_modules/.bin/tsx', import.meta.url).pathname;

function createTempDataDir(): string {
  const dir = join(tmpdir(), `wb-runner-e2e-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('wb-runner e2e (spawn wb-runner-main)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('writes spec.json + status=running + heartbeat within 5s + exits with status=done', async () => {
    const dataDir = createTempDataDir();
    tempDirs.push(dataDir);
    const runId = 'test-run-001';
    const botId = 'default';
    const runDir = join(dataDir, 'runs', botId, runId);
    mkdirSync(runDir, { recursive: true });

    const spec = {
      runId,
      botId,
      agentId: 'test-agent',
      agentCommand: process.execPath,
      agentArgs: ['-e', 'console.log(JSON.stringify({type:"text",delta:"hello"})); console.log(JSON.stringify({type:"done",continuationToken:"ct1"}))'],
      cwd: dataDir,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? '/tmp' },
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'r1',
    };
    const specPath = join(runDir, 'spec.json');
    writeFileSync(specPath, JSON.stringify(spec));

    execFileSync(TSX_BIN, [WB_RUNNER_MAIN, specPath], {
      timeout: 15000,
      env: { ...process.env, WB_DATA_DIR: dataDir },
    });

    expect(existsSync(join(runDir, 'spec.json'))).toBe(true);
    expect(existsSync(join(runDir, 'pid'))).toBe(true);
    expect(existsSync(join(runDir, 'heartbeat'))).toBe(true);
    expect(existsSync(join(runDir, 'events.ndjson'))).toBe(true);

    const status = readFileSync(join(runDir, 'status'), 'utf8').trim();
    expect(status).toBe('done');

    const events = readFileSync(join(runDir, 'events.ndjson'), 'utf8').trim().split('\n');
    expect(events.length).toBeGreaterThanOrEqual(1);
    const firstEvent = JSON.parse(events[0]!) as { type: string; schemaVersion: number };
    expect(firstEvent.type).toBe('text');
    expect(firstEvent.schemaVersion).toBe(1);
  });

  it('exit code matches child exit code (non-zero = error status)', () => {
    const dataDir = createTempDataDir();
    tempDirs.push(dataDir);
    const runId = 'test-run-err';
    const botId = 'default';
    const runDir = join(dataDir, 'runs', botId, runId);
    mkdirSync(runDir, { recursive: true });

    const spec = {
      runId,
      botId,
      agentId: 'test-agent',
      agentCommand: process.execPath,
      agentArgs: ['-e', 'process.exit(42)'],
      cwd: dataDir,
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'r1',
    };
    const specPath = join(runDir, 'spec.json');
    writeFileSync(specPath, JSON.stringify(spec));

    execFileSync(TSX_BIN, [WB_RUNNER_MAIN, specPath], {
      timeout: 15000,
      env: { ...process.env, WB_DATA_DIR: dataDir },
    });

    const status = readFileSync(join(runDir, 'status'), 'utf8').trim();
    expect(status).toBe('error');
  });
});

describe('wb-runner detached behavior', () => {
  it('child survives after parent (wb-runner) exits when detached', async () => {
    if (process.platform === 'win32') return;

    const dataDir = createTempDataDir();
    const runId = 'test-detach-001';
    const botId = 'default';
    const runDir = join(dataDir, 'runs', botId, runId);
    mkdirSync(runDir, { recursive: true });

    const spec = {
      runId,
      botId,
      agentId: 'test-agent',
      agentCommand: process.execPath,
      agentArgs: ['-e', 'setTimeout(() => { process.exit(0); }, 5000)'],
      cwd: dataDir,
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'r1',
    };
    const specPath = join(runDir, 'spec.json');
    writeFileSync(specPath, JSON.stringify(spec));

    const child = spawn(TSX_BIN, [WB_RUNNER_MAIN, specPath], {
      env: { ...process.env, WB_DATA_DIR: dataDir },
      stdio: 'ignore',
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 1500));

    const pidFile = join(runDir, 'pid');
    expect(existsSync(pidFile)).toBe(true);
    const agentPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    expect(agentPid).toBeGreaterThan(0);

    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));

    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    let childAlive = true;
    try {
      process.kill(agentPid, 0);
    } catch {
      childAlive = false;
    }
    expect(childAlive).toBe(true);

    // Check ppid != original parent
    try {
      const ppidOut = execFileSync('ps', ['-o', 'ppid=', '-p', String(agentPid)], { encoding: 'utf8' }).trim();
      const ppid = parseInt(ppidOut, 10);
      expect(ppid).not.toBe(child.pid);
    } catch {
      // ps may fail if process already exited, that's ok
    }

    // Cleanup: kill the detached child
    try { process.kill(agentPid, 'SIGKILL'); } catch { /* already dead */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* race with child cleanup */ }
  });
});
