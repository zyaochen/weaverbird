import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMockGroupSyncAutoDocTransport,
  groupSyncMockAutoDocLedgerPath,
  publishAutoDocArtifact,
  type GroupSyncConfig,
  type GroupSyncAutoDocInput,
} from '../../packages/core/src/group-sync/index.js';
import type { DocSinkTransport, RunRegistryConfig } from '../../packages/core/src/run-registry/index.js';

const roots: string[] = [];

const groupSyncConfig: GroupSyncConfig = {
  enabled: true,
  transport: 'mock',
  rpc_timeout_ms: 50,
  sweep_interval_ms: 10_000,
};

const runRegistryConfig: RunRegistryConfig = {
  bitable_base_id: 'base',
  bitable_table_id: 'table',
  app_id: 'app',
  app_secret: 'secret',
  lark_domain: 'https://open.larkoffice.com',
  run_finalize_grace_ms: 30_000,
  doc_url_allowlist: ['*.larkoffice.com'],
};

function installRun(root: string, runId: string, body: string): void {
  const runDir = join(root, 'runs', 'default', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'events.ndjson'), `${JSON.stringify({ type: 'text', delta: body, schemaVersion: 1 })}\n`);
}

function statePath(root: string, runId: string): string {
  return join(root, 'runs', 'default', runId, 'group-sync-docs.json');
}

function docFixture(overrides: Partial<GroupSyncAutoDocInput> = {}): GroupSyncAutoDocInput {
  return {
    request_id: 'req-autodoc-1',
    session_id: 'sid-autodoc-1',
    run_id: 'group-run-1',
    revision: 4,
    artifact_id: 'terminal-doc',
    artifact_label: 'Terminal doc',
    artifact_path: '/tmp/terminal-doc.md',
    sink_run_id: 'sink-run-1',
    terminal_status: 'succeeded',
    existing_doc_urls: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('group-sync auto doc sink', () => {
  it('publishes an auto doc once and preserves the triad', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-group-sync-autodoc-'));
    roots.push(root);
    installRun(root, 'sink-run-1', 'Paragraph '.repeat(320));
    const doc = docFixture();
    const transport = createMockGroupSyncAutoDocTransport(root);

    const first = await publishAutoDocArtifact({
      dataDir: root,
      doc,
      config: groupSyncConfig,
      runRegistryConfig,
      transport,
    });
    const second = await publishAutoDocArtifact({
      dataDir: root,
      doc,
      config: groupSyncConfig,
      runRegistryConfig,
      transport,
    });

    expect(first.sync_failed).toBe(false);
    expect(second.sync_failed).toBe(false);
    expect(second.artifact.sync_id).toBe(first.artifact.sync_id);
    const state = JSON.parse(readFileSync(statePath(root, doc.run_id), 'utf8')) as Record<string, unknown>;
    expect(state['session_id']).toBe(doc.session_id);
    expect(state['run_id']).toBe(doc.run_id);
    expect(state['last_revision']).toBe(doc.revision);
    expect((state['artifacts'] as Array<Record<string, unknown>>)).toHaveLength(1);
    expect(readFileSync(groupSyncMockAutoDocLedgerPath(root), 'utf8')).toContain(doc.sink_run_id);
    expect(readFileSync(join(root, 'runs', 'default', doc.sink_run_id, 'doc-sink.json'), 'utf8')).toContain('https://mock.larkoffice.com/suite/docx/sink-run-1');
  });

  it('records a fail-safe artifact state when doc transport rejects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-group-sync-autodoc-'));
    roots.push(root);
    installRun(root, 'sink-run-2', 'Paragraph '.repeat(320));
    const doc = docFixture({
      request_id: 'req-autodoc-2',
      run_id: 'group-run-2',
      sink_run_id: 'sink-run-2',
      artifact_id: 'terminal-doc-2',
    });
    const transport: DocSinkTransport = {
      create: vi.fn().mockRejectedValue(new Error('doc sink boom')),
    };

    const result = await publishAutoDocArtifact({
      dataDir: root,
      doc,
      config: groupSyncConfig,
      runRegistryConfig,
      transport,
    });

    expect(result.sync_failed).toBe(true);
    expect(result.artifact.doc_sink_failed).toBe(true);
    expect(result.artifact.last_error).toBe('doc sink boom');
    const state = JSON.parse(readFileSync(statePath(root, doc.run_id), 'utf8')) as Record<string, unknown>;
    const artifact = (state['artifacts'] as Array<Record<string, unknown>>)[0];
    expect(artifact?.['sync_failed']).toBe(true);
    expect(artifact?.['doc_sink_failed']).toBe(true);
    expect(artifact?.['last_error']).toBe('doc sink boom');
    expect(existsSync(join(root, 'runs', 'default', doc.sink_run_id, 'doc-fallback.md'))).toBe(true);
  });

  it('keeps multiple artifacts under the same triad while sinking each run separately', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-group-sync-autodoc-'));
    roots.push(root);
    installRun(root, 'sink-run-3a', 'Paragraph '.repeat(320));
    installRun(root, 'sink-run-3b', 'Paragraph '.repeat(320));
    const firstDoc = docFixture({
      request_id: 'req-autodoc-3a',
      run_id: 'group-run-3',
      revision: 7,
      artifact_id: 'terminal-summary',
      sink_run_id: 'sink-run-3a',
    });
    const secondDoc = docFixture({
      request_id: 'req-autodoc-3b',
      run_id: 'group-run-3',
      revision: 7,
      artifact_id: 'postmortem',
      artifact_label: 'Postmortem',
      sink_run_id: 'sink-run-3b',
    });
    const transport = createMockGroupSyncAutoDocTransport(root);

    await publishAutoDocArtifact({ dataDir: root, doc: firstDoc, config: groupSyncConfig, runRegistryConfig, transport });
    const result = await publishAutoDocArtifact({ dataDir: root, doc: secondDoc, config: groupSyncConfig, runRegistryConfig, transport });

    expect(result.sync_failed).toBe(false);
    const state = JSON.parse(readFileSync(statePath(root, firstDoc.run_id), 'utf8')) as Record<string, unknown>;
    const artifacts = state['artifacts'] as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(2);
    expect(new Set(artifacts.map((item) => item['artifact_id']))).toEqual(new Set(['terminal-summary', 'postmortem']));
    expect(new Set(artifacts.map((item) => item['session_id']))).toEqual(new Set([firstDoc.session_id]));
    expect(new Set(artifacts.map((item) => item['run_id']))).toEqual(new Set([firstDoc.run_id]));
    expect(new Set(artifacts.map((item) => item['revision']))).toEqual(new Set([firstDoc.revision]));
  });
});
