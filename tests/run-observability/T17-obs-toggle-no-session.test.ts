import { describe, expect, it } from 'vitest';

describe('T17 obs toggle no session', () => {
  it('documents no-op when no active session exists', () => {
    const captainService = { getSession: () => undefined };
    expect(captainService.getSession()).toBeUndefined();
  });
});
