import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureRunDoc, type DocSinkTransport, type RunRegistryConfig } from '../../packages/core/src/run-registry/index.js';

const roots: string[] = [];
const config: RunRegistryConfig = {
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

function createReadonlyDocGuards(overrides: Partial<DocSinkTransport> = {}): DocSinkTransport {
  return {
    create: overrides.create ?? vi.fn(async () => ({ url: 'https://foo.larkoffice.com/suite/docx/l1', rawOutput: 'ok' })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Doc Sink L1 harness', () => {
  it('replays longform output into doc sink without leaking secrets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-doc-l1-'));
    roots.push(root);
    installRun(root, 'run-fixture-001', `Summary paragraph. ${'detail '.repeat(300)} ou_12345678 oc_abcdef123 tenant_access_token sk-secret`);
    const transport = createReadonlyDocGuards();

    const result = await ensureRunDoc({
      dataDir: root,
      runId: 'run-fixture-001',
      status: 'succeeded',
      config,
      transport,
    });

    expect(result.doc_sink_failed).toBe(false);
    expect(transport.create).toHaveBeenCalledTimes(1);
    const body = (transport.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.body as string;
    expect(body).toContain('Run ID: run-fixture-001');
    expect(body).not.toMatch(/ou_[0-9a-z]{6,}/i);
    expect(body).not.toMatch(/oc_[0-9a-z]{6,}/i);
    expect(body).not.toMatch(/tenant_access_token|sk-secret/i);
  });

  it('fails safe and writes local fallback when create throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-doc-l1-'));
    roots.push(root);
    installRun(root, 'run-fixture-002', `Summary paragraph. ${'detail '.repeat(300)}`);
    const transport = createReadonlyDocGuards({ create: vi.fn(async () => { throw new Error('unexpected real egress path'); }) });

    const result = await ensureRunDoc({
      dataDir: root,
      runId: 'run-fixture-002',
      status: 'succeeded',
      config,
      transport,
    });

    expect(result.doc_sink_failed).toBe(true);
    expect(readFileSync(join(root, 'runs', 'default', 'run-fixture-002', 'doc-fallback.md'), 'utf8')).toContain('Run ID: run-fixture-002');
  });
});
