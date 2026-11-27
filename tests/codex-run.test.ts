import { describe, expect, it } from 'vitest';
import { CodexAgent } from '../packages/core/src/agent/codex.js';
import type { AgentEvent, RunRequest } from '../packages/core/src/index.js';

class FixtureCodexAgent extends CodexAgent {
  constructor(private readonly fixtureEvents: AgentEvent[]) {
    super();
  }

  override run(req: RunRequest) {
    return super.run(req);
  }

  protected override buildProcessSpec(req: RunRequest) {
    return {
      command: process.execPath,
      args: [new URL('./fixtures/cli-subprocess-fixture.mjs', import.meta.url).pathname],
      cwd: req.cwd,
      env: {
        ...process.env,
        FIXTURE_EVENTS: JSON.stringify(this.fixtureEvents),
      },
    };
  }

  protected override mapOutput(payload: unknown): AgentEvent[] {
    return [payload as AgentEvent];
  }
}

describe('codex run wrapper', () => {
  it('emits a synthetic leading system event before an early auth error', async () => {
    const agent = new FixtureCodexAgent([
      { type: 'error', message: 'unexpected status 401 Unauthorized', code: 'auth', recoverable: false },
    ]);

    const events: AgentEvent[] = [];
    for await (const event of agent.run({ prompt: 'hello', cwd: process.cwd(), model: 'gpt-5.4' }).events) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'system', continuationToken: undefined, cwd: process.cwd(), model: 'gpt-5.4' },
      { type: 'error', message: 'unexpected status 401 Unauthorized', code: 'auth', recoverable: false },
    ]);
  });

  it('keeps the synthetic system event even when upstream later emits its own system event', async () => {
    const agent = new FixtureCodexAgent([
      { type: 'system', continuationToken: 'upstream-token', cwd: process.cwd(), model: 'gpt-5.4' },
      { type: 'done', continuationToken: 'upstream-token' },
    ]);

    const events: AgentEvent[] = [];
    for await (const event of agent.run({ prompt: 'hello', cwd: process.cwd(), model: 'gpt-5.4' }).events) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'system', continuationToken: undefined, cwd: process.cwd(), model: 'gpt-5.4' },
      { type: 'system', continuationToken: 'upstream-token', cwd: process.cwd(), model: 'gpt-5.4' },
      { type: 'done', continuationToken: 'upstream-token' },
    ]);
  });
});
