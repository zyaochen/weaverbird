import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAgent } from '../packages/core/src/agent/codex.js';
import { prepareApprovalHookFiles } from '../apps/wb-bot/src/approval-gate/hook-files.js';

const hasCodex = await new CodexAgent().isAvailable();

describe.skipIf(!hasCodex)('codex e2e', () => {
  it('emits terminal output for an unauthenticated run', async () => {
    const agent = new CodexAgent();
    const run = agent.run({ prompt: 'say hello in one word' });
    const events = [] as Array<{ type: string }>;

    for await (const event of run.events) {
      events.push({ type: event.type });
      if (event.type === 'done' || event.type === 'error') break;
    }

    expect(events.some((event) => event.type === 'system')).toBe(true);
    expect(events.some((event) => event.type === 'error' || event.type === 'done')).toBe(true);
    await run.stop();
    await expect(run.waitForExit(5000)).resolves.toBe(true);
  }, 120000);

  // Real-machine guard for the approval-gate codex runtime-args path
  // (apps/wb-bot/src/approval-gate/hook-files.ts buildCodexRuntimeArgs).
  //
  // Codex runs with `--ignore-user-config`, which makes $CODEX_HOME/config.toml
  // a no-op for runtime config (auth still uses CODEX_HOME). The only thing that
  // keeps hooks / model / model_providers alive is the `-c` argv produced by
  // buildCodexRuntimeArgs. Unit tests assert the *shape* of those args; this
  // case asserts a real `codex exec` actually accepts and parses them (it boots
  // far enough to emit thread.started) instead of dying on a flag/TOML error.
  //
  // Safety: the provider points at a non-existent env_key, so the run fails at
  // the auth stage before any real outbound LLM call — no secret lands on disk.
  it('boots a real codex exec with approval-gate runtime args (config parsed, not rejected)', async () => {
    const sourceCodexHome = mkdtempSync(join(tmpdir(), 'codex-e2e-src-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'codex-e2e-data-'));
    const hookScriptPath = join(dataDir, 'approval-hook.mjs');
    writeFileSync(hookScriptPath, '', 'utf8');

    // Source config mirrors the shape wb-bot reads from a real ~/.codex/config.toml.
    // env_key is a deliberately-absent var so codex fails fast at auth, not at config.
    writeFileSync(join(sourceCodexHome, 'config.toml'), [
      'model = "gpt-5.4"',
      'model_reasoning_effort = "xhigh"',
      '',
      '[model_providers.probe]',
      'name = "probe"',
      'base_url = "https://invalid.localhost"',
      'env_key = "WB_E2E_PROBE_ABSENT_KEY"',
      'wire_api = "responses"',
      'supports_websockets = false',
      '',
      '[features]',
      'hooks = true',
      '',
    ].join('\n'), 'utf8');

    const previousCodexHome = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = sourceCodexHome;
    try {
      const files = prepareApprovalHookFiles({ dataDir, hookScriptPath });

      const argv = [
        'exec',
        ...files.codexRuntimeArgs,
        '--json',
        '--skip-git-repo-check',
        '-',
      ];

      const child = spawn('codex', argv, {
        cwd: dataDir,
        env: { ...process.env, CODEX_HOME: files.codexHome },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      child.stdin.end('ping\n');

      const exitCode: number | null = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve(null);
        }, 60000);
        child.once('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      const events = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as { type?: string; thread_id?: string; error?: { message?: string } };
          } catch {
            return null;
          }
        })
        .filter((value): value is NonNullable<typeof value> => value !== null);

      // If `-c` args were malformed (bad flag / invalid TOML), codex exits non-zero
      // before emitting any JSON event and writes the parse error to stderr.
      const threadStarted = events.some((event) => event.type === 'thread.started');
      const configParseError = /unknown (flag|option)|invalid (toml|value)|error parsing|unrecognized/i.test(stderr);

      expect(
        threadStarted,
        `codex did not emit thread.started — config args were likely rejected.\nargv=${JSON.stringify(argv)}\nstdout=${stdout}\nstderr=${stderr}`,
      ).toBe(true);
      expect(
        configParseError,
        `codex reported a config-parse error.\nstderr=${stderr}`,
      ).toBe(false);

      // The run must reach the auth stage (proving hooks+provider config all parsed)
      // and fail there, rather than hanging or succeeding silently.
      const reachedAuthStage =
        events.some((event) => event.type === 'turn.started') ||
        events.some((event) => event.type === 'error' || event.type === 'turn.failed');
      expect(
        reachedAuthStage,
        `codex neither started a turn nor reported a terminal error.\nstdout=${stdout}\nstderr=${stderr}`,
      ).toBe(true);

      void exitCode;
    } finally {
      if (previousCodexHome === undefined) delete process.env['CODEX_HOME'];
      else process.env['CODEX_HOME'] = previousCodexHome;
      // codex can still be flushing files into these dirs right after its
      // process exits; under concurrent test runs that races rmSync with
      // ENOTEMPTY. maxRetries lets Node back off instead of failing teardown.
      rmSync(sourceCodexHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  }, 90000);
});
