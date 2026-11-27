import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInlineMinutesClient,
  createMockMinutesClient,
  fetchMinutesToRun,
  minutesMockFetchLedgerPath,
  runMinutesStatePath,
  type MinutesContent,
  type MinutesFetchRequest,
} from '../../packages/core/src/minutes/index.js';

const roots: string[] = [];

function requestFixture(overrides: Partial<MinutesFetchRequest> = {}): MinutesFetchRequest {
  return {
    request_id: 'req-minutes-1',
    session_id: 'sid-minutes-1',
    run_id: 'run-minutes-1',
    revision: 2,
    minute_id: 'minute-001',
    content_kind: 'summary',
    requested_at: '2026-06-30T00:00:00.000Z',
    ...overrides,
  };
}

function contentFixture(overrides: Partial<MinutesContent> = {}): MinutesContent {
  return {
    minute_id: 'minute-001',
    title: 'Launch review',
    content: 'Decision log\n- keep adapter additive\n- keep real auth guarded',
    source_url: 'https://mock.larkoffice.com/minutes/minute-001',
    fetched_at: '2026-06-30T00:00:01.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('minutes adapter', () => {
  it('attaches fetched minutes content to the target run and preserves the triad', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-minutes-'));
    roots.push(root);
    const request = requestFixture();
    const client = createMockMinutesClient(root, {
      'minute-001': contentFixture(),
    });

    const result = await fetchMinutesToRun({
      dataDir: root,
      request,
      client,
      nowFn: () => Date.parse('2026-06-30T00:00:02.000Z'),
    });

    expect(result.attach_failed).toBe(false);
    expect(result.artifact.attach_failed).toBe(false);
    expect(result.artifact.minute_title).toBe('Launch review');
    expect(result.artifact.artifact_path).not.toBeNull();
    expect(existsSync(result.artifact.artifact_path ?? '')).toBe(true);
    expect(readFileSync(result.artifact.artifact_path ?? '', 'utf8')).toContain('run_id: run-minutes-1');
    expect(readFileSync(result.artifact.artifact_path ?? '', 'utf8')).toContain('keep adapter additive');
    const state = JSON.parse(readFileSync(runMinutesStatePath(root, request.run_id), 'utf8')) as Record<string, unknown>;
    expect(state['session_id']).toBe(request.session_id);
    expect(state['run_id']).toBe(request.run_id);
    expect(state['last_revision']).toBe(request.revision);
    expect((state['artifacts'] as Array<Record<string, unknown>>)).toHaveLength(1);
    expect(readFileSync(minutesMockFetchLedgerPath(root), 'utf8')).toContain(request.minute_id);
  });

  it('records a fail-safe state when the minutes client rejects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-minutes-'));
    roots.push(root);
    const request = requestFixture({ run_id: 'run-minutes-fail', minute_id: 'minute-fail' });

    const result = await fetchMinutesToRun({
      dataDir: root,
      request,
      client: createInlineMinutesClient(async () => {
        throw new Error('minutes auth missing');
      }),
      nowFn: () => Date.parse('2026-06-30T00:00:03.000Z'),
    });

    expect(result.attach_failed).toBe(true);
    expect(result.artifact.attach_failed).toBe(true);
    expect(result.artifact.last_error).toBe('minutes auth missing');
    expect(result.artifact.artifact_path).toBeNull();
    const state = JSON.parse(readFileSync(runMinutesStatePath(root, request.run_id), 'utf8')) as Record<string, unknown>;
    const artifacts = state['artifacts'] as Array<Record<string, unknown>>;
    expect(artifacts[0]?.['attach_failed']).toBe(true);
    expect(artifacts[0]?.['last_error']).toBe('minutes auth missing');
  });

  it('keeps multiple minutes sources isolated under the same run triad', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-minutes-'));
    roots.push(root);
    const first = requestFixture({ request_id: 'req-minutes-2a', run_id: 'run-minutes-2', revision: 4, minute_id: 'minute-201' });
    const second = requestFixture({ request_id: 'req-minutes-2b', run_id: 'run-minutes-2', revision: 4, minute_id: 'minute-202', content_kind: 'transcript' });
    const client = createMockMinutesClient(root, {
      'minute-201': contentFixture({ minute_id: 'minute-201', title: 'Retro summary', source_url: 'https://mock.larkoffice.com/minutes/minute-201' }),
      'minute-202': contentFixture({ minute_id: 'minute-202', title: 'Retro transcript', content: 'Full transcript body', source_url: 'https://mock.larkoffice.com/minutes/minute-202' }),
    });

    await fetchMinutesToRun({ dataDir: root, request: first, client, nowFn: () => Date.parse('2026-06-30T00:00:04.000Z') });
    const result = await fetchMinutesToRun({ dataDir: root, request: second, client, nowFn: () => Date.parse('2026-06-30T00:00:05.000Z') });

    expect(result.attach_failed).toBe(false);
    const state = JSON.parse(readFileSync(runMinutesStatePath(root, first.run_id), 'utf8')) as Record<string, unknown>;
    const artifacts = state['artifacts'] as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(2);
    expect(new Set(artifacts.map((artifact) => artifact['minute_id']))).toEqual(new Set(['minute-201', 'minute-202']));
    expect(new Set(artifacts.map((artifact) => artifact['session_id']))).toEqual(new Set([first.session_id]));
    expect(new Set(artifacts.map((artifact) => artifact['run_id']))).toEqual(new Set([first.run_id]));
    expect(new Set(artifacts.map((artifact) => artifact['revision']))).toEqual(new Set([first.revision]));
  });

  it('replays idempotently without fetching or duplicating the same minutes source twice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-minutes-'));
    roots.push(root);
    const request = requestFixture({ request_id: 'req-minutes-3', run_id: 'run-minutes-3', minute_id: 'minute-301' });
    const fetchMinutes = vi.fn(async () => contentFixture({ minute_id: 'minute-301', title: 'Ops review', source_url: 'https://mock.larkoffice.com/minutes/minute-301' }));
    const client = createInlineMinutesClient(fetchMinutes);

    const first = await fetchMinutesToRun({ dataDir: root, request, client, nowFn: () => Date.parse('2026-06-30T00:00:06.000Z') });
    const second = await fetchMinutesToRun({ dataDir: root, request: { ...request, request_id: 'req-minutes-3-replay' }, client, nowFn: () => Date.parse('2026-06-30T00:00:07.000Z') });

    expect(first.attach_failed).toBe(false);
    expect(second.attach_failed).toBe(false);
    expect(fetchMinutes).toHaveBeenCalledTimes(1);
    expect(second.artifact.attach_id).toBe(first.artifact.attach_id);
    const state = JSON.parse(readFileSync(runMinutesStatePath(root, request.run_id), 'utf8')) as Record<string, unknown>;
    expect((state['artifacts'] as Array<Record<string, unknown>>)).toHaveLength(1);
  });
});
