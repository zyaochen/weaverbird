import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resumeInheritCommand } from '../../apps/wb-cli/src/commands/resume.js';
import { listCommand } from '../../apps/wb-cli/src/commands/list.js';
import { historyCommand } from '../../apps/wb-cli/src/commands/history.js';

vi.mock('@weaverbird/core/run-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weaverbird/core/run-registry')>();
  const runRecord = {
    run_id: 'run-xyz',
    created_at: '2026-08-04T08:00:00Z',
    operator: 'ou-me',
    project: 'weaverbird',
    cwd: '/repo',
    scope: 'dev',
    agent: 'claude-code',
    cmd: 'fix flaky test',
    status: 'succeeded',
    cost_tokens: null,
    cost_minutes: null,
    produced_doc_urls: [],
    commit_shas: [],
    doc_sink_failed: false,
    calendar_block_id: null,
    calendar_hook_failed: false,
    risk_level: 'low',
    home_group_id: 'oc_home',
    entry_form: 'im',
  };
  const findByRunId = vi.fn(async (runId: string) => (runId === 'run-xyz' ? runRecord : null));
  const queryRuns = vi.fn(async () => ({ runs: [runRecord], next_cursor: null, total_hint: 1 }));
  return {
    ...actual,
    createRunRegistryWriter: vi.fn(() => ({ findByRunId, queryRuns })),
    RUN_REGISTRY_ERROR_CODES: { ...actual.RUN_REGISTRY_ERROR_CODES },
    __testFindByRunId: findByRunId,
    __testQueryRuns: queryRuns,
  };
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
describe('wb-cli resume --inherit', () => {
  it('rejects when --inherit is missing', async () => {
    const code = await resumeInheritCommand([]);
    expect(code).toBe(1);
  });

  it('resolves an inherited run and prints the inherited fields', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await resumeInheritCommand(['--inherit', 'run-xyz']);
    expect(code).toBe(0);
    const stdout = write.mock.calls.map((call) => String(call[0])).join('');
    expect(stdout).toContain('run-xyz');
    expect(stdout).toContain('agent=claude-code');
    expect(stdout).toContain('cwd=/repo');
    expect(stdout).toContain('scope=dev');
    expect(stdout).toContain('project=weaverbird');
    expect(stdout).toContain('home_group_id=oc_home');
    expect(stdout).toContain('entry_form=im');
    write.mockRestore();
  });

  it('exits 2 when the run is not in the registry', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await resumeInheritCommand(['--inherit', 'run-missing']);
    expect(code).toBe(2);
    const stderr = errSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(stderr).toContain('registry.inherit.run_not_found');
    errSpy.mockRestore();
  });

  it('rejects when --inherit flag has no value', async () => {
    const code = await resumeInheritCommand(['--inherit']);
    expect(code).toBe(1);
  });
});

describe('wb-cli list --all-captains', () => {
  it('writes one line per run ordered by created_at', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await listCommand([]);
    expect(code).toBe(0);
    const stdout = write.mock.calls.map((call) => String(call[0])).join('');
    expect(stdout).toContain('run-xyz');
    expect(stdout).toContain('succeeded');
    write.mockRestore();
  });

  it('prints an empty marker instead of nothing when there are no runs', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const registryModule = (await import('@weaverbird/core/run-registry')) as unknown as {
      __testQueryRuns: ReturnType<typeof vi.fn>;
    };
    registryModule.__testQueryRuns.mockResolvedValueOnce({ runs: [], next_cursor: null, total_hint: 0 });
    const code = await listCommand([]);
    expect(code).toBe(0);
    const stdout = write.mock.calls.map((call) => String(call[0])).join('');
    expect(stdout).toContain('(no runs across captains)');
    write.mockRestore();
  });
});

describe('wb-cli history --all-captains', () => {
  it('passes the flag through and emits view=all-captains footer', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await historyCommand(['--all-captains']);
    expect(code).toBe(0);
    const stderr = errSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(stderr).toContain('view=all-captains');
    write.mockRestore();
    errSpy.mockRestore();
  });

  it('does not claim all-captains when flag absent', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await historyCommand([]);
    expect(code).toBe(0);
    const stderr = errSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(stderr).not.toContain('view=all-captains');
    errSpy.mockRestore();
  });
});
