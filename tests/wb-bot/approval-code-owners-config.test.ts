import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApprovalCodeOwnerConfig, resolveApprovalCodeOwnerConfigPath, resolveConfiguredCodeOwners } from '../../apps/wb-bot/src/config/approval-code-owners.js';

const roots: string[] = [];

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-approval-codeowners-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  delete process.env['WB_APPROVAL_CODE_OWNER_CONFIG_PATH'];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('approval code owner fixed config', () => {
  it('loads valid config from local file path', () => {
    const root = mkRoot();
    const path = join(root, 'approval-codeowners.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      repositories: [{
        repoRoot: '/repo',
        branches: [{
          name: 'main',
          rules: [{ paths: ['apps/**'], codeOwnerOpenIds: ['ou_code_owner_1'] }],
        }],
      }],
    }, null, 2));
    chmodSync(path, 0o600);

    const config = loadApprovalCodeOwnerConfig({ configPath: path });
    expect(config.repositories).toHaveLength(1);
    expect(resolveConfiguredCodeOwners(config, {
      repoRoot: '/repo',
      branch: 'main',
      changedPaths: ['apps/wb-bot/src/main.ts'],
    })).toEqual(['ou_code_owner_1']);
  });

  it('resolves config path from env', () => {
    const root = mkRoot();
    const path = join(root, 'approval-codeowners.json');
    writeFileSync(path, JSON.stringify({ version: 1, repositories: [{ repoRoot: '/repo', branches: [{ name: 'main', rules: [{ paths: ['**'], codeOwnerOpenIds: ['ou_code_owner_1'] }] }] }] }, null, 2));
    chmodSync(path, 0o600);
    process.env['WB_APPROVAL_CODE_OWNER_CONFIG_PATH'] = path;
    expect(resolveApprovalCodeOwnerConfigPath()).toBe(path);
  });

  it('fails closed when path is missing', () => {
    expect(() => loadApprovalCodeOwnerConfig()).toThrow(/path is missing/);
  });

  it('fails closed on invalid open_id format', () => {
    const root = mkRoot();
    const path = join(root, 'approval-codeowners.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      repositories: [{
        repoRoot: '/repo',
        branches: [{
          name: 'main',
          rules: [{ paths: ['**'], codeOwnerOpenIds: ['bad-id'] }],
        }],
      }],
    }, null, 2));
    chmodSync(path, 0o600);
    expect(() => loadApprovalCodeOwnerConfig({ configPath: path })).toThrow(/invalid/);
  });

  it('fails closed on permissions that are too open', () => {
    const root = mkRoot();
    const path = join(root, 'approval-codeowners.json');
    writeFileSync(path, JSON.stringify({ version: 1, repositories: [{ repoRoot: '/repo', branches: [{ name: 'main', rules: [{ paths: ['**'], codeOwnerOpenIds: ['ou_code_owner_1'] }] }] }] }, null, 2));
    chmodSync(path, 0o644);
    expect(() => loadApprovalCodeOwnerConfig({ configPath: path })).toThrow(/permissions are too open/);
  });

  it('fails closed when no rule matches a changed path', () => {
    const root = mkRoot();
    const path = join(root, 'approval-codeowners.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      repositories: [{
        repoRoot: '/repo',
        branches: [{
          name: 'main',
          rules: [{ paths: ['docs/**'], codeOwnerOpenIds: ['ou_code_owner_1'] }],
        }],
      }],
    }, null, 2));
    chmodSync(path, 0o600);
    const config = loadApprovalCodeOwnerConfig({ configPath: path });
    expect(() => resolveConfiguredCodeOwners(config, {
      repoRoot: '/repo',
      branch: 'main',
      changedPaths: ['apps/wb-bot/src/main.ts'],
    })).toThrow(/no approval rule matched path/);
  });
});
