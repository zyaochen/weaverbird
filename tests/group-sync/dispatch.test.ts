import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInlineGroupSyncDispatchTransport,
  dispatchGroupSyncCommand,
  type GroupSyncCommandReceived,
} from '../../packages/core/src/group-sync/index.js';

const roots: string[] = [];

function statePath(root: string, runId: string): string {
  return join(root, 'runs', 'default', runId, 'group-sync-dispatch.json');
}

function commandFixture(overrides: Partial<GroupSyncCommandReceived> = {}): GroupSyncCommandReceived {
  return {
    request_id: 'req-dispatch-1',
    session_id: 'sid-dispatch-1',
    run_id: 'run-dispatch-1',
    revision: 2,
    text: '/review status',
    scheduled_at: '2026-06-30T00:00:00.000Z',
    user_open_id: 'ou_dispatch',
    thread_id: 'oc_thread_1',
    message_id: 'om_message_1',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('group-sync dispatch orchestration', () => {
  it('routes a command through the inline transport and records the triad', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-group-sync-dispatch-'));
    roots.push(root);
    const command = commandFixture();
    const seen: GroupSyncCommandReceived[] = [];

    const result = await dispatchGroupSyncCommand({
      dataDir: root,
      command,
      transport: createInlineGroupSyncDispatchTransport(async (input) => {
        seen.push(input);
      }),
      nowFn: () => Date.parse('2026-06-30T00:00:01.000Z'),
    });

    expect(result.dispatch_failed).toBe(false);
    expect(seen).toEqual([expect.objectContaining({ session_id: 'sid-dispatch-1', run_id: 'run-dispatch-1', revision: 2 })]);
    const state = JSON.parse(readFileSync(statePath(root, command.run_id), 'utf8')) as Record<string, unknown>;
    expect(state['session_id']).toBe(command.session_id);
    expect(state['run_id']).toBe(command.run_id);
    expect(state['last_revision']).toBe(command.revision);
    const records = state['commands'] as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]?.['dispatch_failed']).toBe(false);
    expect(records[0]?.['thread_id']).toBe(command.thread_id);
    expect(records[0]?.['message_id']).toBe(command.message_id);
  });

  it('records a fail-safe dispatch state when the transport rejects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-group-sync-dispatch-'));
    roots.push(root);
    const command = commandFixture({ request_id: 'req-dispatch-2', run_id: 'run-dispatch-2' });

    const result = await dispatchGroupSyncCommand({
      dataDir: root,
      command,
      transport: createInlineGroupSyncDispatchTransport(async () => {
        throw new Error('dispatch boom');
      }),
      nowFn: () => Date.parse('2026-06-30T00:00:02.000Z'),
    });

    expect(result.dispatch_failed).toBe(true);
    expect(result.record.dispatch_failed).toBe(true);
    expect(result.record.last_error).toBe('dispatch boom');
    const state = JSON.parse(readFileSync(statePath(root, command.run_id), 'utf8')) as Record<string, unknown>;
    const records = state['commands'] as Array<Record<string, unknown>>;
    expect(records[0]?.['dispatch_failed']).toBe(true);
    expect(records[0]?.['last_error']).toBe('dispatch boom');
  });

  it('keeps multiple command dispatches isolated for the same run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-group-sync-dispatch-'));
    roots.push(root);
    const first = commandFixture({ request_id: 'req-dispatch-3a', run_id: 'run-dispatch-3', revision: 3, text: '/review diff' });
    const second = commandFixture({ request_id: 'req-dispatch-3b', run_id: 'run-dispatch-3', revision: 4, text: '/review ship', message_id: 'om_message_2' });
    const seen: string[] = [];
    const transport = createInlineGroupSyncDispatchTransport(async (input) => {
      seen.push(input.request_id);
    });

    await dispatchGroupSyncCommand({ dataDir: root, command: first, transport, nowFn: () => Date.parse('2026-06-30T00:00:03.000Z') });
    const result = await dispatchGroupSyncCommand({ dataDir: root, command: second, transport, nowFn: () => Date.parse('2026-06-30T00:00:04.000Z') });

    expect(result.dispatch_failed).toBe(false);
    expect(seen).toEqual(['req-dispatch-3a', 'req-dispatch-3b']);
    const state = JSON.parse(readFileSync(statePath(root, first.run_id), 'utf8')) as Record<string, unknown>;
    const records = state['commands'] as Array<Record<string, unknown>>;
    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => record['request_id']))).toEqual(new Set(['req-dispatch-3a', 'req-dispatch-3b']));
    expect(new Set(records.map((record) => record['session_id']))).toEqual(new Set([first.session_id]));
    expect(new Set(records.map((record) => record['run_id']))).toEqual(new Set([first.run_id]));
  });
});
