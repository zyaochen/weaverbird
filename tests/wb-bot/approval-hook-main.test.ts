import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAdminApproverOpenIds, resolveWriteToMainBranchApprovers, runApprovalHook } from '../../apps/wb-bot/src/approval-gate/hook-main.js';

const roots: string[] = [];

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-approval-hook-main-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('approval hook main', () => {
  it('resolves writeToMainBranch approvers from fixed config', () => {
    const root = mkRoot();
    const configPath = join(root, 'approval-codeowners.json');
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      repositories: [{
        repoRoot: root,
        branches: [{ name: 'main', rules: [{ paths: ['apps/**'], codeOwnerOpenIds: ['ou_code_owner_1'] }] }],
      }],
    }, null, 2));
    chmodSync(configPath, 0o600);

    const gitRunner = (args: string[]) => {
      if (args.join(' ') === 'rev-parse --show-toplevel') return root;
      if (args.join(' ') === 'diff --name-only HEAD^ HEAD') return 'apps/wb-bot/src/main.ts';
      throw new Error('unexpected git call');
    };

    expect(resolveWriteToMainBranchApprovers(root, 'ou_owner', {
      WB_APPROVAL_CODE_OWNER_CONFIG_PATH: configPath,
    }, gitRunner)).toEqual(['ou_code_owner_1', 'ou_owner']);
  });

  it('fails closed when fixed config path is missing', () => {
    expect(() => resolveWriteToMainBranchApprovers('/repo', 'ou_owner', {})).toThrow(/config path is missing/);
  });

  it('fails closed when no approval rule matches the changed path', () => {
    const root = mkRoot();
    const configPath = join(root, 'approval-codeowners.json');
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      repositories: [{
        repoRoot: root,
        branches: [{ name: 'main', rules: [{ paths: ['docs/**'], codeOwnerOpenIds: ['ou_code_owner_1'] }] }],
      }],
    }, null, 2));
    chmodSync(configPath, 0o600);

    const gitRunner = (args: string[]) => {
      if (args.join(' ') === 'rev-parse --show-toplevel') return root;
      if (args.join(' ') === 'diff --name-only HEAD^ HEAD') return 'apps/wb-bot/src/main.ts';
      throw new Error('unexpected git call');
    };

    expect(() => resolveWriteToMainBranchApprovers(root, 'ou_owner', {
      WB_APPROVAL_CODE_OWNER_CONFIG_PATH: configPath,
    }, gitRunner)).toThrow(/no approval rule matched path/);
  });

  describe('resolveAdminApproverOpenIds (envVarChange / externalDepUpgrade)', () => {
    it('returns owner list when WB_APPROVAL_ADMIN_OPEN_IDS is set', () => {
      const result = resolveAdminApproverOpenIds({
        WB_APPROVAL_ADMIN_OPEN_IDS: 'ou_admin_a, ou_admin_b',
      }, 'ou_requester');
      expect(result.approvers).toEqual(['ou_admin_a', 'ou_admin_b']);
      expect(result.fallbackNote).toBeNull();
    });

    it('dedupes and sorts, drops empty entries', () => {
      const result = resolveAdminApproverOpenIds({
        WB_APPROVAL_ADMIN_OPEN_IDS: 'ou_admin_b,  ,ou_admin_a,ou_admin_b,',
      }, 'ou_requester');
      expect(result.approvers).toEqual(['ou_admin_a', 'ou_admin_b']);
    });

    it('rejects malformed open_ids (does not silently leak through)', () => {
      const result = resolveAdminApproverOpenIds({
        WB_APPROVAL_ADMIN_OPEN_IDS: 'notanopen_id,ou_admin_a',
      }, 'ou_requester');
      // 未通过 OPEN_ID_PATTERN 的 id 会被丢掉,只剩一个合法的
      expect(result.approvers).toEqual(['ou_admin_a']);
      expect(result.fallbackNote).toBeNull();
    });

    it('FALLS BACK to [userOpenId] with a warning note when env unset/empty', () => {
      const result = resolveAdminApproverOpenIds({}, 'ou_requester');
      expect(result.approvers).toEqual(['ou_requester']);
      expect(result.fallbackNote).toMatch(/WB_APPROVAL_ADMIN_OPEN_IDS/);
    });
  });
});
