import { describe, expect, it, vi } from 'vitest';
import { createConcurrencyQueueIndex } from '../../packages/core/src/captain/concurrency-queue-index.js';
import { createQueueMetricsAggregator } from '../../packages/core/src/captain/queue-metrics/aggregator.js';
import { handleReverseAtImCommand } from '../../apps/wb-bot/src/feishu/reverse-at-im-handler.js';

describe('T5-im-commands', () => {
  const injectedSessionId = 'bot-1:ou_owner:sid-001';

  function makeOptions(overrides: { sessionId?: string } = {}) {
    const index = createConcurrencyQueueIndex();
    const store = { append: vi.fn() };
    const replyText = vi.fn(async () => 'reply-1');
    const metrics = createQueueMetricsAggregator();
    const recordSpy = vi.spyOn(metrics, 'record');
    return {
      index,
      store,
      replyText,
      metrics,
      recordSpy,
      options: {
        captainService: { listActiveSessions: () => [] } as any,
        dataDir: '/tmp',
        feishu: { replyCard: vi.fn(async () => 'reply-card'), replyText },
        captainConcurrency: {
          index,
          store,
          metrics,
          now: () => '2026-06-10T00:00:00.000Z',
          sessionId: overrides.sessionId,
        },
      },
    };
  }

  const context = {
    messageId: 'm1',
    threadId: 'sid-001',
    userOpenId: 'ou_owner',
  };

  it('T12 /queue 空', async () => {
    const { replyText, options } = makeOptions({ sessionId: 'sid-001' });

    await handleReverseAtImCommand({
      command: '/queue',
      run_id: 'n/a',
      requester_open_id: 'ou_owner',
      requested_at: '2026-06-10T00:00:00.000Z',
      message_id: 'm1',
    }, context, options);

    expect(replyText).toHaveBeenCalledWith('m1', 'running\n- (empty)\nqueued\n- (empty)');
  });

  it('T13 /queue 1r+2q', async () => {
    const { index, replyText, options } = makeOptions({ sessionId: 'sid-001' });
    index.markRunning('sid-001', 'run-r1', '2026-06-10T00:00:00.000Z');
    index.enqueue('sid-001', 'run-q1', '2026-06-10T00:00:01.000Z');
    index.enqueue('sid-001', 'run-q2', '2026-06-10T00:00:02.000Z');

    await handleReverseAtImCommand({
      command: '/queue',
      run_id: 'n/a',
      requester_open_id: 'ou_owner',
      requested_at: '2026-06-10T00:00:00.000Z',
      message_id: 'm1',
    }, context, options);

    expect(replyText).toHaveBeenCalledWith('m1', 'running\n- run-r1\nqueued\n- run-q1\n- run-q2');
  });

  it('T14 /cancel-all 2q → 全 cancelled', async () => {
    const { index, store, replyText, options } = makeOptions({ sessionId: 'sid-001' });
    index.enqueue('sid-001', 'run-q1', '2026-06-10T00:00:01.000Z');
    index.enqueue('sid-001', 'run-q2', '2026-06-10T00:00:02.000Z');

    await handleReverseAtImCommand({
      command: '/cancel-all',
      run_id: 'n/a',
      requester_open_id: 'ou_owner',
      requested_at: '2026-06-10T00:00:00.000Z',
      message_id: 'm1',
    }, context, options);

    expect(store.append).toHaveBeenNthCalledWith(1, {
      session_id: 'sid-001',
      run_id: 'run-q1',
      status: 'ended',
      ts: '2026-06-10T00:00:00.000Z',
      reason: 'cancelled',
    });
    expect(store.append).toHaveBeenNthCalledWith(2, {
      session_id: 'sid-001',
      run_id: 'run-q2',
      status: 'ended',
      ts: '2026-06-10T00:00:00.000Z',
      reason: 'cancelled',
    });
    expect(index.listQueued('sid-001')).toEqual([]);
    expect(replyText).toHaveBeenCalledWith('m1', 'cancelled 2 queued run(s)');
  });

  it('T15 /preempt 1r+1q → r preempted, q 提升', async () => {
    const { index, store, replyText, options } = makeOptions({ sessionId: 'sid-001' });
    index.markRunning('sid-001', 'run-r1', '2026-06-10T00:00:00.000Z');
    index.enqueue('sid-001', 'run-q1', '2026-06-10T00:00:01.000Z');

    await handleReverseAtImCommand({
      command: '/preempt',
      run_id: 'n/a',
      requester_open_id: 'ou_owner',
      requested_at: '2026-06-10T00:00:00.000Z',
      message_id: 'm1',
    }, context, options);

    expect(store.append).toHaveBeenNthCalledWith(1, {
      session_id: 'sid-001',
      run_id: 'run-r1',
      status: 'ended',
      ts: '2026-06-10T00:00:00.000Z',
      reason: 'preempted',
    });
    expect(store.append).toHaveBeenNthCalledWith(2, {
      session_id: 'sid-001',
      run_id: 'run-q1',
      status: 'running',
      ts: '2026-06-10T00:00:00.000Z',
    });
    expect(index.listRunning('sid-001')).toEqual(['run-q1']);
    expect(index.listQueued('sid-001')).toEqual([]);
    expect(replyText).toHaveBeenCalledWith('m1', 'preempted 1 running run(s)\n- promoted run-q1');
  });

  it('T9 /queue → commands_total{command=queue}+1 with injected session_id', async () => {
    const { metrics, recordSpy, options } = makeOptions({ sessionId: injectedSessionId });

    await handleReverseAtImCommand({
      command: '/queue',
      run_id: 'n/a',
      requester_open_id: 'ou_owner',
      requested_at: '2026-06-10T00:00:00.000Z',
      message_id: 'm1',
    }, context, options);

    expect(metrics.snapshot({ session_id: injectedSessionId }).counters.captain_queue_commands_total).toBe(1);
    expect(recordSpy).toHaveBeenCalledWith({
      metric: 'captain_queue_commands_total',
      value: 1,
      labels: { session_id: injectedSessionId, command: 'queue' },
    });
  });

  it('T10 /cancel-all 2q → cancelled_runs_total+2, commands_total{command=cancel_all}+1', async () => {
    const { index, metrics, recordSpy, options } = makeOptions({ sessionId: injectedSessionId });
    index.enqueue(injectedSessionId, 'run-q1', '2026-06-10T00:00:01.000Z');
    index.enqueue(injectedSessionId, 'run-q2', '2026-06-10T00:00:02.000Z');

    await handleReverseAtImCommand({
      command: '/cancel-all',
      run_id: 'n/a',
      requester_open_id: 'ou_owner',
      requested_at: '2026-06-10T00:00:00.000Z',
      message_id: 'm1',
    }, context, options);

    const snapshot = metrics.snapshot({ session_id: injectedSessionId });
    expect(snapshot.counters.captain_queue_commands_total).toBe(1);
    expect(snapshot.counters.captain_queue_cancelled_runs_total).toBe(2);
    expect(recordSpy).toHaveBeenCalledWith({
      metric: 'captain_queue_commands_total',
      value: 1,
      labels: { session_id: injectedSessionId, command: 'cancel_all' },
    });
  });

  it('T11 /preempt 1r+1q → preempted+1, promoted_by_preempt+1', async () => {
    const { index, metrics, recordSpy, options } = makeOptions({ sessionId: injectedSessionId });
    index.markRunning(injectedSessionId, 'run-r1', '2026-06-10T00:00:00.000Z');
    index.enqueue(injectedSessionId, 'run-q1', '2026-06-10T00:00:01.000Z');

    await handleReverseAtImCommand({
      command: '/preempt',
      run_id: 'n/a',
      requester_open_id: 'ou_owner',
      requested_at: '2026-06-10T00:00:00.000Z',
      message_id: 'm1',
    }, context, options);

    const snapshot = metrics.snapshot({ session_id: injectedSessionId });
    expect(snapshot.counters.captain_queue_commands_total).toBe(1);
    expect(snapshot.counters.captain_queue_preempted_runs_total).toBe(1);
    expect(snapshot.counters.captain_queue_promoted_by_preempt_total).toBe(1);
    expect(recordSpy).toHaveBeenCalledWith({
      metric: 'captain_queue_commands_total',
      value: 1,
      labels: { session_id: injectedSessionId, command: 'preempt' },
    });
  });

  it('T12 /preempt 1r+0q → preempted+1, promoted_by_preempt unchanged', async () => {
    const { index, metrics, recordSpy, options } = makeOptions({ sessionId: injectedSessionId });
    index.markRunning(injectedSessionId, 'run-r1', '2026-06-10T00:00:00.000Z');

    await handleReverseAtImCommand({
      command: '/preempt',
      run_id: 'n/a',
      requester_open_id: 'ou_owner',
      requested_at: '2026-06-10T00:00:00.000Z',
      message_id: 'm1',
    }, context, options);

    const snapshot = metrics.snapshot({ session_id: injectedSessionId });
    expect(snapshot.counters.captain_queue_commands_total).toBe(1);
    expect(snapshot.counters.captain_queue_preempted_runs_total).toBe(1);
    expect(snapshot.counters.captain_queue_promoted_by_preempt_total).toBeUndefined();
    expect(recordSpy).toHaveBeenCalledWith({
      metric: 'captain_queue_commands_total',
      value: 1,
      labels: { session_id: injectedSessionId, command: 'preempt' },
    });
    expect(recordSpy).not.toHaveBeenCalledWith(expect.objectContaining({
      metric: 'captain_queue_promoted_by_preempt_total',
    }));
  });
});
