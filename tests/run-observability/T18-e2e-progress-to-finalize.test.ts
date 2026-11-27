import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProgressStore } from '../../packages/core/src/run-observability/progress-store.js';
import { ProgressCollector } from '../../packages/core/src/run-observability/progress-collector.js';
import { CardPipeline } from '../../apps/wb-bot/src/feishu/card-pipeline.js';
import { CardRefresher } from '../../packages/core/src/run-observability/card-refresher.js';
import { ObservabilityStoreEntrySchema } from '../../packages/core/src/run-observability/contracts.js';
import { finalizeRun } from '../../packages/core/src/run-observability/finalizer.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];

describe('T18 e2e progress to finalize', () => {
  it('captures progress, refreshes card, and finalizes in one local flow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-obs-e2e-'));
    roots.push(dir);
    const store = new ProgressStore({ dataDir: dir, botId: 'default', runId: 'run-001', sessionId: 'sid-001' });
    const collector = new ProgressCollector(store, () => '2026-06-10T00:00:00.000Z');
    collector.push('stdout', 'step1\nstep2\n');
    const entry = store.readEntry();
    expect(entry).not.toBeNull();
    const patch = vi.fn(async () => undefined);
    const refresher = new CardRefresher(new CardPipeline(patch, 0), () => undefined, () => '2026-06-10T00:00:05.000Z');
    await refresher.finalize(ObservabilityStoreEntrySchema.parse({ ...entry!, card_message_id: 'card-1', origin_message_id: 'm1' }), 'step2');
    const replyCard = vi.fn(async () => undefined);
    const updateCard = vi.fn(async () => undefined);
    const sendCard = vi.fn(async () => undefined);
    const lines = readFileSync(store.progressPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line).text as string);
    const ok = await finalizeRun(ObservabilityStoreEntrySchema.parse({ ...entry!, card_message_id: 'card-1', origin_message_id: 'm1' }), lines, {
      client: { updateCard, replyCard, sendCard },
      dataDir: dir,
      nowIso: '2026-06-10T00:10:00.000Z',
    });
    expect(ok).toBe(true);
    expect(updateCard).toHaveBeenCalledTimes(1);
    expect(replyCard).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
});
