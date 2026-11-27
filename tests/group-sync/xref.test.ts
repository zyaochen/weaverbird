import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMockGroupSyncReferenceTransport,
  groupSyncMockReferenceLedgerPath,
  publishCrossGroupReference,
  type GroupSyncConfig,
  type GroupSyncCrossGroupReferenceInput,
  type GroupSyncReferenceTransport,
} from '../../packages/core/src/group-sync/index.js';

const roots: string[] = [];
const config: GroupSyncConfig = {
  enabled: true,
  transport: 'mock',
  rpc_timeout_ms: 50,
  sweep_interval_ms: 10_000,
};

function statePath(root: string, runId: string): string {
  return join(root, 'runs', 'default', runId, 'group-sync-xrefs.json');
}

function referenceFixture(overrides: Partial<GroupSyncCrossGroupReferenceInput> = {}): GroupSyncCrossGroupReferenceInput {
  return {
    request_id: 'req-xref-1',
    session_id: 'sid-xref-1',
    run_id: 'run-xref-1',
    revision: 2,
    source_thread_id: 'oc_source_thread',
    source_message_id: 'om_source_message',
    target_thread_id: 'oc_target_thread',
    target_message_id: 'om_target_message',
    artifact_kind: 'run',
    artifact_label: 'run summary',
    artifact_path: '/tmp/run-xref-1.md',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('group-sync xref', () => {
  it('publishes a cross-group run reference once and preserves the triad', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-group-sync-xref-'));
    roots.push(root);
    const reference = referenceFixture();
    const transport = createMockGroupSyncReferenceTransport(root);

    const first = await publishCrossGroupReference({ dataDir: root, reference, config, transport });
    const second = await publishCrossGroupReference({ dataDir: root, reference, config, transport });

    expect(first.sync_failed).toBe(false);
    expect(second.sync_failed).toBe(false);
    expect(second.reference.reference_id).toBe(first.reference.reference_id);

    const state = JSON.parse(readFileSync(statePath(root, reference.run_id), 'utf8')) as Record<string, unknown>;
    expect(state['session_id']).toBe(reference.session_id);
    expect(state['run_id']).toBe(reference.run_id);
    expect(state['last_revision']).toBe(reference.revision);
    expect(readFileSync(groupSyncMockReferenceLedgerPath(root), 'utf8')).toContain(`"run_id":"${reference.run_id}"`);
    expect(readFileSync(groupSyncMockReferenceLedgerPath(root), 'utf8')).toContain(`"target_thread_id":"${reference.target_thread_id}"`);
    expect((state['references'] as Array<Record<string, unknown>>)).toHaveLength(1);
  });

  it('records a fail-safe xref state when transport rejects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-group-sync-xref-'));
    roots.push(root);
    const reference = referenceFixture({ request_id: 'req-xref-2', run_id: 'run-xref-2' });
    const transport: GroupSyncReferenceTransport = {
      publishReference: vi.fn().mockRejectedValue(new Error('xref egress boom')),
    };

    const result = await publishCrossGroupReference({ dataDir: root, reference, config, transport });

    expect(result.sync_failed).toBe(true);
    expect(result.reference.sync_failed).toBe(true);
    expect(result.reference.last_error).toBe('xref egress boom');
    const state = JSON.parse(readFileSync(statePath(root, reference.run_id), 'utf8')) as Record<string, unknown>;
    expect((state['references'] as Array<Record<string, unknown>>)[0]?.['sync_failed']).toBe(true);
    expect((state['references'] as Array<Record<string, unknown>>)[0]?.['last_error']).toBe('xref egress boom');
  });

  it('keeps run and session identity stable while allowing multiple artifact kinds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-group-sync-xref-'));
    roots.push(root);
    const runReference = referenceFixture({ request_id: 'req-xref-3', run_id: 'run-xref-3' });
    const diffReference = referenceFixture({
      request_id: 'req-xref-4',
      run_id: 'run-xref-3',
      artifact_kind: 'diff',
      artifact_label: 'diff summary',
      target_message_id: 'om_target_message_2',
    });
    const transport = createMockGroupSyncReferenceTransport(root);

    await publishCrossGroupReference({ dataDir: root, reference: runReference, config, transport });
    const result = await publishCrossGroupReference({ dataDir: root, reference: diffReference, config, transport });

    expect(result.sync_failed).toBe(false);
    const state = JSON.parse(readFileSync(statePath(root, runReference.run_id), 'utf8')) as Record<string, unknown>;
    const references = state['references'] as Array<Record<string, unknown>>;
    expect(references).toHaveLength(2);
    expect(references.map((item) => item['artifact_kind'])).toEqual(['run', 'diff']);
    expect(new Set(references.map((item) => item['session_id']))).toEqual(new Set([runReference.session_id]));
    expect(new Set(references.map((item) => item['run_id']))).toEqual(new Set([runReference.run_id]));
    expect(new Set(references.map((item) => item['revision']))).toEqual(new Set([runReference.revision]));
  });
});
