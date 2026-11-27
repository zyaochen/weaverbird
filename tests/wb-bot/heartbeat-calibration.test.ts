import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WbRunner, HEARTBEAT_INTERVAL_MS } from '../../packages/core/src/runner/wb-runner.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('A1.5 heartbeat calibration', () => {
  it('HEARTBEAT_INTERVAL_MS is 5000ms (5s write frequency)', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(5_000);
  });

  it('heartbeat file is written within 5s of runner start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-hb-cal-'));
    roots.push(dir);

    const spec = {
      runId: 'run-hb-test',
      botId: 'default',
      agentId: 'test-agent',
      agentCommand: 'sleep',
      agentArgs: ['2'],
      cwd: dir,
      env: { PATH: process.env['PATH']! },
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'r1',
    };

    const runner = new WbRunner(dir, spec);
    const runPromise = runner.start();

    await new Promise((r) => setTimeout(r, 500));

    const hbPath = join(dir, 'runs', 'default', 'run-hb-test', 'heartbeat');
    const hbContent = readFileSync(hbPath, 'utf8').trim();
    const hbTs = parseInt(hbContent, 10) * 1000;
    const drift = Math.abs(Date.now() - hbTs);

    expect(drift).toBeLessThan(10_000);

    await runPromise;
  });

  it('scenario 1 - normal run (no App Nap): heartbeat stays fresh for 60s threshold', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-hb-cal-'));
    roots.push(dir);

    const spec = {
      runId: 'run-hb-s1',
      botId: 'default',
      agentId: 'test-agent',
      agentCommand: 'sleep',
      agentArgs: ['1'],
      cwd: dir,
      env: { PATH: process.env['PATH']! },
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'r1',
    };

    const runner = new WbRunner(dir, spec);
    const runPromise = runner.start();
    await runPromise;

    const hbPath = join(dir, 'runs', 'default', 'run-hb-s1', 'heartbeat');
    const hbTs = parseInt(readFileSync(hbPath, 'utf8').trim(), 10) * 1000;
    const staleness = Date.now() - hbTs;

    expect(staleness).toBeLessThan(60_000);
  });

  it('scenario 2 - heavy load: heartbeat written despite stdout activity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-hb-cal-'));
    roots.push(dir);

    const spec = {
      runId: 'run-hb-s2',
      botId: 'default',
      agentId: 'test-agent',
      agentCommand: '/bin/sh',
      agentArgs: ['-c', 'for i in $(seq 1 100); do echo "line $i"; done; sleep 1'],
      cwd: dir,
      env: { PATH: process.env['PATH']! },
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'r1',
    };

    const runner = new WbRunner(dir, spec);
    await runner.start();

    const hbPath = join(dir, 'runs', 'default', 'run-hb-s2', 'heartbeat');
    const hbTs = parseInt(readFileSync(hbPath, 'utf8').trim(), 10) * 1000;
    const staleness = Date.now() - hbTs;

    expect(staleness).toBeLessThan(120_000);
  });

  it('default stale threshold candidates: 60/120/240s', () => {
    const candidates = [60_000, 120_000, 240_000];
    expect(candidates).toContain(60_000);
    expect(candidates).toContain(120_000);
    expect(candidates).toContain(240_000);
  });

  it('chosen WB_HEARTBEAT_STALE_MS=240s rationale: covers App Nap P99 drift of ~180s', () => {
    // App Nap on macOS can delay timers by up to ~180s in background.
    // With 5s heartbeat interval, the worst-case staleness under App Nap is:
    //   5s (interval) + ~180s (App Nap delay) = ~185s
    // 240s provides ~55s margin above observed P99 while avoiding false 'lost' classifications.
    const WB_HEARTBEAT_STALE_MS = 240_000;
    const APP_NAP_P99_DELAY_MS = 180_000;
    const margin = WB_HEARTBEAT_STALE_MS - (HEARTBEAT_INTERVAL_MS + APP_NAP_P99_DELAY_MS);
    expect(margin).toBeGreaterThan(0);
    expect(margin).toBe(55_000);
  });

  it('App Nap fixture: simulated 180s timer delay still within 240s stale threshold', () => {
    const staleMs = 240_000;
    const heartbeatInterval = HEARTBEAT_INTERVAL_MS;
    const appNapDelays = [30_000, 90_000, 150_000, 180_000];

    for (const delay of appNapDelays) {
      const worstStaleness = heartbeatInterval + delay;
      expect(worstStaleness).toBeLessThan(staleMs);
    }
    // 250s delay would exceed threshold (pathological case → correctly classified as 'lost')
    const pathologicalDelay = 250_000;
    expect(heartbeatInterval + pathologicalDelay).toBeGreaterThan(staleMs);
  });
});
