import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObservabilityStoreEntrySchema } from '../../packages/core/src/run-observability/contracts.js';
import { finalizeRun } from '../../packages/core/src/run-observability/finalizer.js';
import { RUN_REGISTRY_ERROR_CODES } from '../../packages/core/src/run-registry/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-finalize-doc-sink-'));
  roots.push(root);
  return root;
}

function entry(dataDir: string) {
  return ObservabilityStoreEntrySchema.parse({
    run_id: 'run-doc-1',
    session_id: 'sess-1',
    status: 'succeeded',
    updated_at: '2026-06-10T00:00:00.000Z',
    last_stdout_at: '2026-06-10T00:00:00.000Z',
    origin_message_id: 'm1',
    card_message_id: 'card-1',
    home_group_id: 'grp-1',
    created_at: '2026-06-10T00:00:00.000Z',
    alert_reason: null,
    produced_doc_urls: [],
    doc_sink_attempted_at: null,
    doc_sink_last_reason: null,
  });
}

function writeRegistryConfig(root: string): void {
  const cfgDir = join(root, 'config');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'run-registry.json'), JSON.stringify({
    bitable_base_id: 'b',
    bitable_table_id: 't',
    app_id: 'a',
    app_secret: 's',
    lark_domain: 'https://example.com',
    run_finalize_grace_ms: 1000,
  }));
}

describe('T12-M11-C finalize auto doc-sink', () => {
  it('skips doc-sink when skipDocSink is set', async () => {
    const root = mkRoot();
    writeRegistryConfig(root);
    const finalizeEntry = entry(root);
    let stored: string | null = null;
    const onFinalized = () => { stored = entry(root).run_id; };
    const ok = await finalizeRun(finalizeEntry, [], {
      client: {
        updateCard: async () => {},
        replyCard: async () => {},
        sendCard: async () => {},
      },
      dataDir: root,
      onFinalized,
      skipDocSink: true,
      larkEnv: {},
    });
    expect(ok).toBe(true);
    expect(finalizeEntry.doc_sink_attempted_at).toBeNull();
    expect(stored).toBe('run-doc-1');
  });

  it('captures doc_sink_last_reason as not_terminal when status is running', async () => {
    const root = mkRoot();
    writeRegistryConfig(root);
    const runningEntry = ObservabilityStoreEntrySchema.parse({
      ...entry(root),
      status: 'active',
    });
    const ok = await finalizeRun(runningEntry, ['x'], {
      client: {
        updateCard: async () => {},
        replyCard: async () => {},
        sendCard: async () => {},
      },
      dataDir: root,
      nowIso: '2026-06-10T00:10:00.000Z',
      larkEnv: {},
    });
    expect(ok).toBe(true);
    expect(runningEntry.doc_sink_attempted_at).toBe('2026-06-10T00:10:00.000Z');
    expect(runningEntry.doc_sink_last_reason).toBe('not_terminal');
    expect(runningEntry.produced_doc_urls).toEqual([]);
  });

  it('records error+reason when run-registry config is missing', async () => {
    const root = mkRoot();
    // do NOT write registry config; loadRunRegistryConfig will throw missing config
    const finalizeEntry = entry(root);
    const missingConfigEnv = {
      WB_DATA_DIR: join(root, 'data'),
      WB_RUN_REGISTRY_CONFIG: join(root, 'nope.json'),
    };
    const ok = await finalizeRun(finalizeEntry, ['a'], {
      client: {
        updateCard: async () => {},
        replyCard: async () => {},
        sendCard: async () => {},
      },
      dataDir: root,
      nowIso: '2026-06-10T00:10:00.000Z',
      larkEnv: missingConfigEnv,
    });
    expect(ok).toBe(true);
    expect(finalizeEntry.doc_sink_attempted_at).toBe('2026-06-10T00:10:00.000Z');
    expect(finalizeEntry.doc_sink_last_reason ?? '').toMatch(new RegExp(`^error:`));
    expect(finalizeEntry.doc_sink_last_reason ?? '').toContain(RUN_REGISTRY_ERROR_CODES.E_CFG_MISSING);
  });
});
