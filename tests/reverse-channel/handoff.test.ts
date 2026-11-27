import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInheritedRun } from '../../apps/wb-bot/src/commands/resume.js';
import {
  createInlineReverseHandoffTransport,
  publishReverseHandoff,
  recordReverseHandoffFromSession,
  type ReverseHandoffInput,
  type ReverseHandoffNotification,
} from '../../packages/core/src/reverse-channel/index.js';
import type { SessionRecord } from '../../packages/core/src/captain/index.js';

const roots: string[] = [];

function statePath(root: string, runId: string): string {
  return join(root, 'runs', 'default', runId, 'reverse-handoff.json');
}

function handoffFixture(overrides: Partial<ReverseHandoffInput> = {}): ReverseHandoffInput {
  return {
    session_id: 'sid-handoff-1',
    run_id: 'run-handoff-1',
    revision: 3,
    changed_at: '2026-06-30T00:00:00.000Z',
    previous_captain_id: 'captain-a',
    next_captain_id: 'captain-b',
    previous_holder_open_id: 'ou_old',
    next_holder_open_id: 'ou_new',
    project: 'weaverbird',
    cwd: '/repo',
    scope: 'dev',
    agent: 'claude-code',
    home_group_id: 'grp-001',
    entry_form: 'im',
    ...overrides,
  };
}

function sessionFixture(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    session_id: 'sid-session-1',
    captain_id: 'captain-a',
    created_at: '2026-06-30T00:00:00.000Z',
    last_active_at: '2026-06-30T00:00:00.000Z',
    closed_at: null,
    status: 'active',
    cwd: '/repo',
    scope: 'dev',
    project: 'weaverbird',
    home_group_id: 'grp-001',
    agent: 'claude-code',
    latest_run_id: 'run-session-1',
    operator: 'ou_old',
    entry_form: 'im',
    revision: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('reverse handoff orchestration', () => {
  it('notifies the new holder and records the inherited fields from the run context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-reverse-handoff-'));
    roots.push(root);
    const handoff = handoffFixture({ run_id: 'run-handoff-success' });
    const notifications: ReverseHandoffNotification[] = [];

    const result = await publishReverseHandoff({
      dataDir: root,
      handoff,
      transport: createInlineReverseHandoffTransport(async (input) => {
        notifications.push(input);
      }),
      nowFn: () => Date.parse('2026-06-30T00:00:01.000Z'),
    });

    expect(result.notify_failed).toBe(false);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      session_id: handoff.session_id,
      run_id: handoff.run_id,
      revision: handoff.revision,
      previous_holder_open_id: 'ou_old',
      next_holder_open_id: 'ou_new',
    });
    const inherited = buildInheritedRun({
      run_id: handoff.run_id,
      created_at: handoff.changed_at,
      operator: handoff.next_holder_open_id,
      project: handoff.project,
      cwd: handoff.cwd,
      scope: handoff.scope,
      agent: handoff.agent,
      cmd: 'claude',
      status: 'active',
      cost_tokens: null,
      cost_minutes: null,
      produced_doc_urls: [],
      commit_shas: [],
      doc_sink_failed: false,
      calendar_block_id: null,
      calendar_hook_failed: false,
      risk_level: 'unknown',
      home_group_id: handoff.home_group_id,
      entry_form: handoff.entry_form,
    }, 'new-run-id');
    expect(result.record.project).toBe(inherited.inherited.project);
    expect(result.record.cwd).toBe(inherited.inherited.cwd);
    expect(result.record.scope).toBe(inherited.inherited.scope);
    expect(result.record.agent).toBe(inherited.inherited.agent);
    expect(result.record.home_group_id).toBe(inherited.inherited.home_group_id);
    expect(result.record.entry_form).toBe(inherited.inherited.entry_form);

    const state = JSON.parse(readFileSync(statePath(root, handoff.run_id), 'utf8')) as Record<string, unknown>;
    expect(state['session_id']).toBe(handoff.session_id);
    expect(state['run_id']).toBe(handoff.run_id);
    expect(state['last_revision']).toBe(handoff.revision);
    const records = state['handoffs'] as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]?.['notified_at']).toBe('2026-06-30T00:00:01.000Z');
  });

  it('records a fail-safe handoff state when reverse-@ notification rejects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-reverse-handoff-'));
    roots.push(root);
    const handoff = handoffFixture({ run_id: 'run-handoff-fail', revision: 4 });

    const result = await publishReverseHandoff({
      dataDir: root,
      handoff,
      transport: createInlineReverseHandoffTransport(async () => {
        throw new Error('reverse-at boom');
      }),
      nowFn: () => Date.parse('2026-06-30T00:00:02.000Z'),
    });

    expect(result.notify_failed).toBe(true);
    expect(result.record.notify_failed).toBe(true);
    expect(result.record.last_error).toBe('reverse-at boom');
    const state = JSON.parse(readFileSync(statePath(root, handoff.run_id), 'utf8')) as Record<string, unknown>;
    const records = state['handoffs'] as Array<Record<string, unknown>>;
    expect(records[0]?.['notify_failed']).toBe(true);
    expect(records[0]?.['last_error']).toBe('reverse-at boom');
    expect(records[0]?.['notified_at']).toBeNull();
  });

  it('keeps repeated holder changes idempotent for the same revision and target holder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-reverse-handoff-'));
    roots.push(root);
    const previousSession = sessionFixture();
    const nextSession = sessionFixture({
      captain_id: 'captain-b',
      operator: 'ou_new',
      last_active_at: '2026-06-30T00:00:03.000Z',
    });
    const notifications: ReverseHandoffNotification[] = [];
    const transport = createInlineReverseHandoffTransport(async (input) => {
      notifications.push(input);
    });

    const first = await recordReverseHandoffFromSession({
      dataDir: root,
      previousSession,
      nextSession,
      revision: 5,
      transport,
      nowFn: () => Date.parse('2026-06-30T00:00:03.000Z'),
    });
    const second = await recordReverseHandoffFromSession({
      dataDir: root,
      previousSession,
      nextSession,
      revision: 5,
      transport,
      nowFn: () => Date.parse('2026-06-30T00:00:04.000Z'),
    });

    expect(first?.notify_failed).toBe(false);
    expect(second?.notify_failed).toBe(false);
    expect(second?.record.handoff_id).toBe(first?.record.handoff_id);
    expect(notifications).toHaveLength(1);
    const state = JSON.parse(readFileSync(statePath(root, nextSession.latest_run_id ?? 'missing'), 'utf8')) as Record<string, unknown>;
    const records = state['handoffs'] as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]?.['next_holder_open_id']).toBe('ou_new');
  });
});
