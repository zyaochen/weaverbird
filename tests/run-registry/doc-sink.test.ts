import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('doc-sink', () => {
  it('creates a doc for longform output and stores state marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-doc-sink-'));
    roots.push(root);
    installRun(root, 'run-001', 'Paragraph '.repeat(300));
    const transport: DocSinkTransport = {
      create: vi.fn().mockResolvedValue({ url: 'https://foo.larkoffice.com/suite/docx/abc', rawOutput: 'ok' }),
    };

    const result = await ensureRunDoc({
      dataDir: root,
      runId: 'run-001',
      status: 'succeeded',
      config,
      transport,
    });

    expect(result.produced_doc_urls).toEqual(['https://foo.larkoffice.com/suite/docx/abc']);
    expect(result.doc_sink_failed).toBe(false);
    expect((transport.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(root, 'runs', 'default', 'run-001', 'doc-sink.json'), 'utf8')).toContain('https://foo.larkoffice.com/suite/docx/abc');
  });

  it('skips repeated create when success marker already exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-doc-sink-'));
    roots.push(root);
    installRun(root, 'run-002', 'Paragraph '.repeat(300));
    const runDir = join(root, 'runs', 'default', 'run-002');
    writeFileSync(join(runDir, 'doc-sink.json'), JSON.stringify({
      run_id: 'run-002',
      status: 'succeeded',
      doc_url: 'https://foo.larkoffice.com/suite/docx/existing',
      error_code: null,
      error_message: null,
      updated_at: '2026-06-27T00:00:00.000Z',
    }, null, 2));
    const transport: DocSinkTransport = { create: vi.fn() };

    const result = await ensureRunDoc({
      dataDir: root,
      runId: 'run-002',
      status: 'succeeded',
      config,
      transport,
    });

    expect(result.produced_doc_urls).toEqual(['https://foo.larkoffice.com/suite/docx/existing']);
    expect((transport.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('writes fallback and failed state when transport errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-doc-sink-'));
    roots.push(root);
    installRun(root, 'run-003', 'Paragraph '.repeat(300));
    const transport: DocSinkTransport = {
      create: vi.fn().mockRejectedValue(new Error('boom')),
    };

    const result = await ensureRunDoc({
      dataDir: root,
      runId: 'run-003',
      status: 'succeeded',
      config,
      transport,
    });

    expect(result.produced_doc_urls).toEqual([]);
    expect(result.doc_sink_failed).toBe(true);
    expect(readFileSync(join(root, 'runs', 'default', 'run-003', 'doc-fallback.md'), 'utf8')).toContain('Run ID: run-003');
    expect(readFileSync(join(root, 'runs', 'default', 'run-003', 'doc-sink.json'), 'utf8')).toContain('failed');
  });

  it('does not sink short output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-doc-sink-'));
    roots.push(root);
    installRun(root, 'run-004', 'short summary');
    const transport: DocSinkTransport = { create: vi.fn() };

    const result = await ensureRunDoc({
      dataDir: root,
      runId: 'run-004',
      status: 'succeeded',
      config,
      transport,
    });

    expect(result.reason).toBe('not_longform');
    expect((transport.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('returns locked without creating a duplicate doc while another create is in flight', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-doc-sink-'));
    roots.push(root);
    installRun(root, 'run-005', 'Paragraph '.repeat(300));
    let releaseCreate!: (value: { url: string; rawOutput: string }) => void;
    const transport: DocSinkTransport = {
      create: vi.fn().mockImplementation(() => new Promise<{ url: string; rawOutput: string }>((resolve) => {
        releaseCreate = resolve;
      })),
    };

    const first = ensureRunDoc({
      dataDir: root,
      runId: 'run-005',
      status: 'succeeded',
      config,
      transport,
    });
    const second = await ensureRunDoc({
      dataDir: root,
      runId: 'run-005',
      status: 'succeeded',
      config,
      transport,
    });
    releaseCreate?.({ url: 'https://foo.larkoffice.com/suite/docx/lock', rawOutput: 'ok' });
    const firstResult = await first;

    expect(second.reason).toBe('locked');
    expect(firstResult.reason).toBe('created');
    expect((transport.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('preserves existing produced_doc_urls when success marker already exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-doc-sink-'));
    roots.push(root);
    installRun(root, 'run-006', 'Paragraph '.repeat(300));
    const runDir = join(root, 'runs', 'default', 'run-006');
    writeFileSync(join(runDir, 'doc-sink.json'), JSON.stringify({
      run_id: 'run-006',
      status: 'succeeded',
      doc_url: 'https://foo.larkoffice.com/suite/docx/existing',
      error_code: null,
      error_message: null,
      updated_at: '2026-06-27T00:00:00.000Z',
    }, null, 2));

    const result = await ensureRunDoc({
      dataDir: root,
      runId: 'run-006',
      status: 'succeeded',
      config,
      existingDocUrls: ['https://github.com/example/repo/pull/1'],
      transport: { create: vi.fn() },
    });

    expect(result.produced_doc_urls).toEqual([
      'https://github.com/example/repo/pull/1',
      'https://foo.larkoffice.com/suite/docx/existing',
    ]);
  });

  it('cleans up lock file after completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-doc-sink-'));
    roots.push(root);
    installRun(root, 'run-007', 'Paragraph '.repeat(300));

    await ensureRunDoc({
      dataDir: root,
      runId: 'run-007',
      status: 'succeeded',
      config,
      transport: { create: vi.fn().mockResolvedValue({ url: 'https://foo.larkoffice.com/suite/docx/done', rawOutput: 'ok' }) },
    });

    expect(existsSync(join(root, 'runs', 'default', 'run-007', 'doc-sink.lock'))).toBe(false);
  });
});
