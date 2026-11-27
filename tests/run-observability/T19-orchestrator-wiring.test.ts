import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProgressStore } from '../../packages/core/src/run-observability/progress-store.js';
import { ProgressCollector } from '../../packages/core/src/run-observability/progress-collector.js';
import { CardPipeline } from '../../apps/wb-bot/src/feishu/card-pipeline.js';
import { CardRefresher } from '../../packages/core/src/run-observability/card-refresher.js';
import { wireRunObservability } from '../../apps/wb-bot/src/run-observability/orchestrator.js';

const roots: string[] = [];

describe('T19 orchestrator wiring', () => {
  it('runs collector -> refresher -> finalizer flow on local files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-obs-orch-'));
    roots.push(dir);
    const runDir = join(dir, 'runs', 'default', 'run-001');
    const store = new ProgressStore({
      dataDir: dir,
      botId: 'default',
      runId: 'run-001',
      sessionId: 'sid-001',
      originMessageId: 'm1',
      cardMessageId: 'card-1',
      homeGroupId: 'grp',
    });
    const collector = new ProgressCollector(store, () => '2026-06-10T00:00:00.000Z');
    const patch = vi.fn(async () => undefined);
    const refresher = new CardRefresher(new CardPipeline(patch, 0), () => undefined, () => '2026-06-10T00:00:05.000Z');
    const updateCard = vi.fn(async () => undefined);
    const replyCard = vi.fn(async () => undefined);
    const sendCard = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => undefined);
    const wiring = wireRunObservability(runDir, {
      collector,
      store,
      refresher,
      finalizerClient: { updateCard, replyCard, sendCard },
      dataDir: dir,
      alertContext: {
        session: { session_id: 'sid-001', home_group_id: 'grp', operator: 'ou_abc', agent: 'claude-code' },
        dataDir: dir,
        client: { sendMessage },
        alertEnabled: true,
        alreadyAlerted: false,
      },
    });

    wiring.onStdout('step1\n');
    wiring.onStderr('warn1\n');
    await wiring.onExit({ status: 'failed', cancelled: false, elapsedS: 10, exitMeta: { exit_code: 1, signal: 'SIGTERM' } });

    const progress = readFileSync(join(runDir, 'progress.ndjson'), 'utf8');
    expect(progress).toContain('step1');
    expect(progress).toContain('warn1');
    const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as { status: string; finalized: boolean; cancelled: boolean; home_group_id?: string | null };
    expect(meta).toMatchObject({ status: 'failed', finalized: true, cancelled: false, home_group_id: 'grp' });
    expect(updateCard).toHaveBeenCalledTimes(1);
    expect(replyCard).toHaveBeenCalledTimes(1);
    const firstUpdatedCard = (updateCard.mock.calls[0] as [string, Record<string, unknown>] | undefined)?.[1] ?? {};
    expect(JSON.stringify(firstUpdatedCard)).toContain('status: failed');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
});
