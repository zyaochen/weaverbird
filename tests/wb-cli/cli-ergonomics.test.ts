import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logsCommand } from '../../apps/wb-cli/src/commands/logs.js';
import { runsCommand, listRuns } from '../../apps/wb-cli/src/commands/runs.js';
import { debugCommand } from '../../apps/wb-cli/src/commands/debug.js';
import { unavailableHint } from '../../apps/wb-cli/src/main.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env['WB_DATA_DIR'];
});

describe('wb-cli logs command', () => {
  it('returns 1 when no run directory found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-cli-logs-'));
    roots.push(dir);
    process.env['WB_DATA_DIR'] = dir;

    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });
    const code = logsCommand({ follow: false, tail: 0 });
    vi.restoreAllMocks();

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('No run directory found');
  });

  it('reads output.log from last-active run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-cli-logs-'));
    roots.push(dir);
    process.env['WB_DATA_DIR'] = dir;

    const runDir = join(dir, 'runs', 'default', 'run-123');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'heartbeat'), String(Math.floor(Date.now() / 1000)));
    writeFileSync(join(runDir, 'output.log'), 'line1\nline2\nline3\n');
    writeFileSync(join(runDir, 'spec.json'), JSON.stringify({ agentId: 'claude-code' }));

    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
    const code = logsCommand({ follow: false, tail: 0 });
    vi.restoreAllMocks();

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('line1');
    expect(stdout.join('')).toContain('line3');
  });

  it('--tail 2 shows last 2 lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-cli-logs-'));
    roots.push(dir);
    process.env['WB_DATA_DIR'] = dir;

    const runDir = join(dir, 'runs', 'default', 'run-tail');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'heartbeat'), String(Math.floor(Date.now() / 1000)));
    writeFileSync(join(runDir, 'output.log'), 'a\nb\nc\nd\ne\n');

    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
    const code = logsCommand({ follow: false, tail: 2 });
    vi.restoreAllMocks();

    expect(code).toBe(0);
    const output = stdout.join('');
    expect(output).toContain('e');
    expect(output).not.toContain('a');
  });

  it('--run-id resolves specific run across botIds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-cli-logs-'));
    roots.push(dir);
    process.env['WB_DATA_DIR'] = dir;

    const runDir = join(dir, 'runs', 'mybot', 'run-specific');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'output.log'), 'specific-output\n');

    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
    const code = logsCommand({ follow: false, tail: 0, runId: 'run-specific' });
    vi.restoreAllMocks();

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('specific-output');
  });
});

describe('wb-cli runs command', () => {
  it('lists runs with last-active marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-cli-runs-'));
    roots.push(dir);
    process.env['WB_DATA_DIR'] = dir;

    const now = Math.floor(Date.now() / 1000);
    const run1Dir = join(dir, 'runs', 'default', 'run-old');
    const run2Dir = join(dir, 'runs', 'default', 'run-new');
    mkdirSync(run1Dir, { recursive: true });
    mkdirSync(run2Dir, { recursive: true });
    writeFileSync(join(run1Dir, 'heartbeat'), String(now - 3600));
    writeFileSync(join(run1Dir, 'status'), 'done');
    writeFileSync(join(run1Dir, 'spec.json'), JSON.stringify({ agentId: 'codex' }));
    writeFileSync(join(run2Dir, 'heartbeat'), String(now));
    writeFileSync(join(run2Dir, 'status'), 'running');
    writeFileSync(join(run2Dir, 'spec.json'), JSON.stringify({ agentId: 'claude-code' }));

    const entries = listRuns();
    expect(entries.length).toBe(2);
    expect(entries[0]!.runId).toBe('run-new');
    expect(entries[1]!.runId).toBe('run-old');

    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
    runsCommand();
    vi.restoreAllMocks();

    const output = stdout.join('');
    expect(output).toContain('run-new');
    expect(output).toContain('★');
  });

  it('returns empty when no data dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-cli-runs-empty-'));
    roots.push(dir);
    process.env['WB_DATA_DIR'] = dir;

    const entries = listRuns();
    expect(entries).toEqual([]);
  });
});

describe('wb-cli debug command', () => {
  it('parses agentId and prompt from argv', () => {
    expect(debugCommand(['codex', '--', 'hello', 'world'])).toEqual({
      agentId: 'codex',
      prompt: 'hello world',
    });
  });

  it('defaults agentId to claude-code when no -- separator agent', () => {
    expect(debugCommand(['--', 'fix', 'bug'])).toEqual({
      agentId: 'claude-code',
      prompt: 'fix bug',
    });
  });

  it('uses positionals as prompt when no -- separator', () => {
    expect(debugCommand(['explain', 'this'])).toEqual({
      agentId: 'claude-code',
      prompt: 'explain this',
    });
  });

  it('returns null when no prompt given', () => {
    expect(debugCommand([])).toBeNull();
    expect(debugCommand(['--'])).toBeNull();
  });
});

describe('W2.5-Hotfix-batch-C P1-8 · unavailableHint per-agent', () => {
  it('claude-code → 提示 @anthropic-ai/claude-code 安装 + claude --version 验证', () => {
    const hint = unavailableHint('claude-code');
    expect(hint).toContain('@anthropic-ai/claude-code');
    expect(hint).toContain('claude --version');
  });

  it('codex → 提示 codex 仓库 + codex --version 验证 (不提 claude)', () => {
    const hint = unavailableHint('codex');
    expect(hint).toContain('codex');
    expect(hint).toContain('codex --version');
    expect(hint).not.toContain('claude');
    expect(hint).not.toContain('@anthropic-ai');
  });

  it('unknown agent → fallback 提示 (不写死 claude install hint)', () => {
    const hint = unavailableHint('mira-cli');
    expect(hint).toContain('mira-cli');
    expect(hint).toContain('list-agents');
    expect(hint).not.toContain('Install claude CLI');
    expect(hint).not.toContain('@anthropic-ai');
  });
});
