import { describe, expect, it } from 'vitest';
import { ClaudeCodeAgent } from '../packages/core/src/agent/claude-code.js';

const hasClaude = await new ClaudeCodeAgent().isAvailable();

describe.skipIf(!hasClaude)('claude code e2e', () => {
  it('emits text and done for a one-word hello run', async () => {
    const previous = process.env['WB_TOOL_PROGRESS_INTERVAL_MS'];
    process.env['WB_TOOL_PROGRESS_INTERVAL_MS'] = '60000';
    try {
      const agent = new ClaudeCodeAgent();
      const run = agent.run({ prompt: 'hello' });
      const events = [] as Array<{ type: string }>;

      for await (const event of run.events) {
        events.push({ type: event.type });
        if (event.type === 'done' || event.type === 'error') break;
      }

      expect(events.some((event) => event.type === 'text')).toBe(true);
      expect(events.some((event) => event.type === 'done')).toBe(true);
      await expect(run.waitForExit(2000)).resolves.toBe(true);
    } finally {
      if (previous === undefined) delete process.env['WB_TOOL_PROGRESS_INTERVAL_MS'];
      else process.env['WB_TOOL_PROGRESS_INTERVAL_MS'] = previous;
    }
  }, 120000);
});
