import { describe, expect, it, vi } from 'vitest';
import type { ConcurrencyConfig } from '../../packages/core/src/captain/concurrency-config.js';
import { createConcurrencyQueueIndex } from '../../packages/core/src/captain/concurrency-queue-index.js';
import { enqueueOrSpawn } from '../../packages/core/src/captain/enqueue-or-spawn.js';

describe('T4-enqueue-or-spawn', () => {
  function makeDeps(config: ConcurrencyConfig) {
    const index = createConcurrencyQueueIndex();
    const store = { append: vi.fn() };
    const now = () => '2026-06-10T00:00:00.000Z';
    return { config, index, store, now };
  }

  it('T8 idle → spawn', async () => {
    const deps = makeDeps({ max_concurrent_runs: 1, queue_max_depth: 10 });

    const result = await enqueueOrSpawn(
      { ...deps, genRunId: () => 'run-1' },
      { session_id: 's1' },
    );

    expect(result).toEqual({ kind: 'spawn', run_id: 'run-1' });
    expect(deps.store.append).toHaveBeenCalledWith({
      session_id: 's1',
      run_id: 'run-1',
      status: 'running',
      ts: '2026-06-10T00:00:00.000Z',
    });
    expect(deps.index.listRunning('s1')).toEqual(['run-1']);
    expect(deps.index.listQueued('s1')).toEqual([]);
  });

  it('T9 full → queued position=1', async () => {
    const deps = makeDeps({ max_concurrent_runs: 1, queue_max_depth: 10 });
    deps.index.markRunning('s1', 'run-active', '2026-06-10T00:00:00.000Z');

    const result = await enqueueOrSpawn(
      { ...deps, genRunId: () => 'run-2' },
      { session_id: 's1' },
    );

    expect(result).toEqual({ kind: 'queued', run_id: 'run-2', position: 1 });
    expect(deps.store.append).toHaveBeenCalledWith({
      session_id: 's1',
      run_id: 'run-2',
      status: 'queued',
      ts: '2026-06-10T00:00:00.000Z',
    });
    expect(deps.index.listQueued('s1')).toEqual(['run-2']);
    expect(deps.index.listRunning('s1')).toEqual(['run-active']);
  });

  it('T10 depth 满 → rejected', async () => {
    const deps = makeDeps({ max_concurrent_runs: 1, queue_max_depth: 1 });
    deps.index.markRunning('s1', 'run-active', '2026-06-10T00:00:00.000Z');
    deps.index.enqueue('s1', 'run-queued', '2026-06-10T00:00:01.000Z');

    const result = await enqueueOrSpawn(
      { ...deps, genRunId: () => 'run-3' },
      { session_id: 's1' },
    );

    expect(result).toEqual({ kind: 'rejected', reason: 'queue_full' });
    expect(deps.store.append).not.toHaveBeenCalled();
    expect(deps.index.listQueued('s1')).toEqual(['run-queued']);
  });

  it('T11 session A 满不阻塞 session B', async () => {
    const deps = makeDeps({ max_concurrent_runs: 1, queue_max_depth: 1 });
    deps.index.markRunning('s1', 'run-active', '2026-06-10T00:00:00.000Z');
    deps.index.enqueue('s1', 'run-queued', '2026-06-10T00:00:01.000Z');

    const result = await enqueueOrSpawn(
      { ...deps, genRunId: () => 'run-b-1' },
      { session_id: 's2' },
    );

    expect(result).toEqual({ kind: 'spawn', run_id: 'run-b-1' });
    expect(deps.index.listRunning('s2')).toEqual(['run-b-1']);
    expect(deps.index.listQueued('s2')).toEqual([]);
  });
});
