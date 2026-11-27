import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CLISubprocessAgent, type CLIProcessSpec, type RunRequest } from '../packages/core/src/index.js';
import type { AgentCapabilities, AgentEvent } from '../packages/core/src/index.js';

const fixturePath = new URL('./fixtures/cli-subprocess-fixture.mjs', import.meta.url).pathname;
const fixtureDir = new URL('./fixtures', import.meta.url).pathname;

class FixtureAgent extends CLISubprocessAgent {
  readonly id = 'fixture';
  readonly displayName = 'Fixture';

  constructor(private readonly specFactory: (req: RunRequest) => CLIProcessSpec) {
    super();
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return {
      type: 'cli',
      input: { images: false, attachments: false },
      output: { streaming: true, thinking: false, toolUse: false, citations: false },
      context: { window: 1, costClass: 'free' },
      skills: { code: 'C', review: 'C', plan: 'C', research: 'C', ops: 'C' },
      tools: { builtin: [], canExtend: false },
      session: { resumable: false, tokenKind: 'opaque' },
    };
  }

  protected buildProcessSpec(req: RunRequest): CLIProcessSpec {
    return this.specFactory(req);
  }

  protected mapOutput(payload: unknown): AgentEvent[] {
    return [payload as AgentEvent];
  }
}

function createSpec(req: RunRequest, env: NodeJS.ProcessEnv = {}): CLIProcessSpec {
  return {
    command: 'node',
    args: [fixturePath],
    cwd: req.cwd,
    env: { ...process.env, ...env },
  };
}

async function collect(run: { events: AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

describe('cli subprocess agent', () => {
  it('keeps only the stderr tail when the process exits with lots of stderr', async () => {
    const noisy = Array.from({ length: 300 }, (_, index) => `stderr-${index.toString().padStart(3, '0')}`);
    const agent = new FixtureAgent((req) => createSpec(req, {
      FIXTURE_STDERR_LINES: JSON.stringify(noisy),
      FIXTURE_EXIT_CODE: '1',
    }));

    const run = agent.run({ prompt: 'hello' });
    const events = await collect(run);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'crashed' });
    const message = events[0]?.type === 'error' ? events[0].message : '';
    expect(message).toContain('stderr-299');
    expect(message).not.toContain('stderr-000');
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(8 * 1024);
  });

  it('allows breaking async iteration without hanging the queue', async () => {
    const agent = new FixtureAgent((req) => createSpec(req, {
      FIXTURE_EVENTS: JSON.stringify([{ type: 'text', delta: 'first' }, { type: 'text', delta: 'second' }]),
      FIXTURE_INTERVAL_MS: '30',
      FIXTURE_KEEP_ALIVE: '1',
    }));

    const run = agent.run({ prompt: 'hello' });
    for await (const event of run.events) {
      expect(event).toEqual({ type: 'text', delta: 'first' });
      break;
    }
    await run.stop();
    await expect(run.waitForExit(20)).resolves.toBe(true);
  });

  it('passes spawn options through optional env and cwd hooks', async () => {
    class HookedAgent extends FixtureAgent {
      protected override envFilter(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        return {
          PATH: env['PATH'] ?? '',
          FILTERED_FLAG: env['KEEP_ME'] ?? '',
          FIXTURE_EMIT_CWD: env['FIXTURE_EMIT_CWD'] ?? '',
          FIXTURE_EMIT_ENV_KEY: env['FIXTURE_EMIT_ENV_KEY'] ?? '',
          FIXTURE_EVENTS: env['FIXTURE_EVENTS'] ?? '',
        };
      }

      protected override cwdGuard(cwd: string | undefined): string | undefined {
        return cwd ? fixtureDir : cwd;
      }
    }

    const agent = new HookedAgent((req) => createSpec(req, {
      KEEP_ME: 'yes',
      DROP_ME: 'no',
      FIXTURE_EMIT_CWD: '1',
      FIXTURE_EMIT_ENV_KEY: 'FILTERED_FLAG',
      FIXTURE_EVENTS: JSON.stringify([{ type: 'done', continuationToken: 'hooked' }]),
    }));

    const run = agent.run({ prompt: 'hello', cwd: process.cwd() });
    await expect(collect(run)).resolves.toEqual([
      { type: 'text', delta: `cwd:${fixtureDir}` },
      { type: 'text', delta: 'env:FILTERED_FLAG=yes' },
      { type: 'done', continuationToken: 'hooked' },
    ]);
  });

  it('supports optional stdin writing hooks', async () => {
    class StdinAgent extends FixtureAgent {
      writes = 0;

      protected override async writeStdin(child: ChildProcess, req: RunRequest): Promise<void> {
        this.writes += 1;
        child.stdin?.end(`${req.prompt}\n`);
      }
    }

    const agent = new StdinAgent((req) => createSpec(req, {
      FIXTURE_READ_STDIN: '1',
      FIXTURE_EVENTS: JSON.stringify([{ type: 'done', continuationToken: 'stdin-ok' }]),
    }));

    const run = agent.run({ prompt: 'hello' });
    await expect(collect(run)).resolves.toEqual([
      { type: 'text', delta: 'stdin:hello' },
      { type: 'done', continuationToken: 'stdin-ok' },
    ]);
    expect(agent.writes).toBe(1);
  });

  it('streams events and exits cleanly', async () => {
    const agent = new FixtureAgent((req) => createSpec(req, {
      FIXTURE_EVENTS: JSON.stringify([{ type: 'text', delta: 'a' }, { type: 'done', continuationToken: 'token-1' }]),
    }));

    const run = agent.run({ prompt: 'hello' });
    await expect(collect(run)).resolves.toEqual([
      { type: 'text', delta: 'a' },
      { type: 'done', continuationToken: 'token-1' },
    ]);
    await expect(run.waitForExit(100)).resolves.toBe(true);
  });

  it('supports mid-stream consumption before completion', async () => {
    const agent = new FixtureAgent((req) => createSpec(req, {
      FIXTURE_EVENTS: JSON.stringify([{ type: 'text', delta: 'first' }, { type: 'text', delta: 'second' }, { type: 'done', continuationToken: 'token-2' }]),
      FIXTURE_INTERVAL_MS: '30',
    }));

    const run = agent.run({ prompt: 'hello' });
    const iterator = run.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: { type: 'text', delta: 'first' }, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: { type: 'text', delta: 'second' }, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: { type: 'done', continuationToken: 'token-2' }, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('waitForExit returns false before the process finishes', async () => {
    const agent = new FixtureAgent((req) => createSpec(req, {
      FIXTURE_EVENTS: JSON.stringify([{ type: 'text', delta: 'wait' }]),
      FIXTURE_KEEP_ALIVE: '1',
    }));

    const run = agent.run({ prompt: 'hello' });
    await expect(run.waitForExit(20)).resolves.toBe(false);
    await run.stop();
    await expect(run.waitForExit(20)).resolves.toBe(true);
  });

  it('stops via SIGTERM within the grace window', async () => {
    const agent = new FixtureAgent((req) => createSpec(req, {
      FIXTURE_EVENTS: JSON.stringify([{ type: 'text', delta: 'hello' }]),
      FIXTURE_KEEP_ALIVE: '1',
      FIXTURE_TERM_BEHAVIOR: 'exit',
      FIXTURE_TERM_DELAY_MS: '20',
    }));

    const run = agent.run({ prompt: 'hello', stopGraceMs: 80 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await run.stop();
    await expect(run.waitForExit(20)).resolves.toBe(true);
  });

  it('escalates to SIGKILL after the grace window', async () => {
    const agent = new FixtureAgent((req) => createSpec(req, {
      FIXTURE_EVENTS: JSON.stringify([{ type: 'text', delta: 'hello' }]),
      FIXTURE_KEEP_ALIVE: '1',
      FIXTURE_TERM_BEHAVIOR: 'ignore',
    }));

    const run = agent.run({ prompt: 'hello', stopGraceMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await run.stop();
    await expect(run.waitForExit(20)).resolves.toBe(true);
  });
});
