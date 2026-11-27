import { describe, expect, it, vi } from 'vitest';
import { CardPipeline } from '../../apps/wb-bot/src/feishu/card-pipeline.js';

describe('card pipeline', () => {
  it('coalesces pending patches', async () => {
    vi.useFakeTimers();
    const calls: Array<Record<string, unknown>> = [];
    const pipeline = new CardPipeline(async (card) => {
      calls.push(card);
    }, 800);
    await pipeline.flush({ v: 1 });
    await pipeline.flush({ v: 2 });
    await vi.advanceTimersByTimeAsync(800);
    expect(calls).toEqual([{ v: 2 }]);
    vi.useRealTimers();
  });

  it('backs off on 230020 errors', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const pipeline = new CardPipeline(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('230020 rate limited');
    }, 800);
    await pipeline.force({ v: 1 });
    await vi.advanceTimersByTimeAsync(800);
    expect(attempts).toBe(2);
    vi.useRealTimers();
  });

  it('retries card-action lock errors', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const pipeline = new CardPipeline(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('230099 card action is lock');
    }, 800);
    await pipeline.force({ v: 1 });
    await vi.advanceTimersByTimeAsync(800);
    expect(attempts).toBe(2);
    vi.useRealTimers();
  });

  it('retries axios lock errors using response data', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const pipeline = new CardPipeline(async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('Request failed with status code 400') as Error & {
          response?: { data?: { code?: number; msg?: string } };
        };
        error.response = { data: { code: 230099, msg: 'card action is lock' } };
        throw error;
      }
    }, 800);
    await pipeline.force({ v: 1 });
    await vi.advanceTimersByTimeAsync(800);
    expect(attempts).toBe(2);
    vi.useRealTimers();
  });

  it('does not issue concurrent patches when flush fires while a patch is in-flight', async () => {
    vi.useFakeTimers();
    const calls: Array<Record<string, unknown>> = [];
    let resolvePatch!: () => void;
    const pipeline = new CardPipeline(async (card) => {
      calls.push(card);
      if (calls.length === 1) {
        // First patch stalls until we manually resolve it.
        await new Promise<void>((r) => { resolvePatch = r; });
      }
    }, 800);

    // Schedule flush – timer fires, drain starts, patch is in-flight.
    await pipeline.flush({ v: 1 });
    await vi.advanceTimersByTimeAsync(800);
    expect(calls.length).toBe(1);

    // Flush a new payload while patch is still in-flight.
    await pipeline.flush({ v: 2 });
    // No second patch should have been issued yet.
    expect(calls.length).toBe(1);

    // Let the first patch settle.
    resolvePatch();
    await vi.advanceTimersByTimeAsync(800);

    // Now the queued payload should be drained.
    expect(calls).toEqual([{ v: 1 }, { v: 2 }]);
    vi.useRealTimers();
  });

  it('queues a force payload and drains it after the in-flight patch settles', async () => {
    vi.useFakeTimers();
    const calls: Array<Record<string, unknown>> = [];
    let resolvePatch!: () => void;
    const pipeline = new CardPipeline(async (card) => {
      calls.push(card);
      if (calls.length === 1) {
        await new Promise<void>((r) => { resolvePatch = r; });
      }
    }, 800);

    // Start a flush so a patch is in-flight.
    await pipeline.flush({ v: 1 });
    await vi.advanceTimersByTimeAsync(800);
    expect(calls.length).toBe(1);

    // Force a newer payload while patch is still in-flight.
    const forcePromise = pipeline.force({ v: 'done' });

    // Settle the in-flight patch.
    resolvePatch();
    await forcePromise;
    await vi.advanceTimersByTimeAsync(800);

    expect(calls).toEqual([{ v: 1 }, { v: 'done' }]);
    vi.useRealTimers();
  });
});
