import { describe, expect, it } from 'vitest';
import { createInitialState, reduceStreamState } from '../../apps/wb-bot/src/feishu/stream-state.js';

describe('stream state', () => {
  it('converges stopping + error into stopped done state', () => {
    const state = {
      ...createInitialState('claude-code', 'Claude Code', 'Claude Code'),
      stopState: 'stopping' as const,
      terminalState: 'running' as const,
      errorMessage: 'previous error',
    };

    const next = reduceStreamState(state, { type: 'error', message: 'stopped by user' });

    expect(next.stopState).toBe('stopped');
    expect(next.terminalState).toBe('done');
    expect(next.errorMessage).toBeUndefined();
  });

  it('keeps non-stop errors as errors', () => {
    const state = createInitialState('claude-code', 'Claude Code', 'Claude Code');

    const next = reduceStreamState(state, { type: 'error', message: 'boom' });

    expect(next.stopState).toBe('running');
    expect(next.terminalState).toBe('error');
    expect(next.errorMessage).toBe('boom');
  });
});
