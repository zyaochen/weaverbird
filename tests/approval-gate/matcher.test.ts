import { describe, expect, it } from 'vitest';
import { matchApprovalGate } from '../../packages/core/src/approval-gate/matcher.js';

describe('approval gate matcher', () => {
  it('matches writeToMainBranch for git push to main', () => {
    const match = matchApprovalGate('Bash', { command: 'git push origin HEAD:main' });
    expect(match?.anchor).toBe('writeToMainBranch');
    expect(match?.approverPolicy).toBe('owner_and_code_owner');
    expect(match?.timeoutMs).toBe(10 * 60 * 1000);
  });

  it('matches envVarChange for .env writes', () => {
    const match = matchApprovalGate('Edit', { file_path: '/repo/apps/wb-bot/.env' });
    expect(match?.anchor).toBe('envVarChange');
    expect(match?.approverPolicy).toBe('owner');
    expect(match?.timeoutMs).toBe(30 * 60 * 1000);
  });

  it('matches externalDepUpgrade for dependency manifest edits', () => {
    const match = matchApprovalGate('Write', { file_path: '/repo/package.json' });
    expect(match?.anchor).toBe('externalDepUpgrade');
    expect(match?.approverPolicy).toBe('owner');
    expect(match?.timeoutMs).toBe(60 * 60 * 1000);
  });

  it('matches externalDepUpgrade for package manager commands', () => {
    const match = matchApprovalGate('Bash', { command: 'pnpm add zod@latest' });
    expect(match?.anchor).toBe('externalDepUpgrade');
  });

  it('returns null for non-dangerous commands', () => {
    expect(matchApprovalGate('Bash', { command: 'npm test' })).toBeNull();
    expect(matchApprovalGate('Read', { file_path: '/repo/README.md' })).toBeNull();
  });
});
