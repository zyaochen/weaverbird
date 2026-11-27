import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestStore } from '../../apps/wb-bot/src/approval-gate/store.js';
import { runApprovalHook } from '../../apps/wb-bot/src/approval-gate/hook-main.js';

const roots: string[] = [];

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-approval-write-main-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['WB_DATA_DIR'];
  delete process.env['WB_APPROVAL_RUN_ID'];
  delete process.env['WB_APPROVAL_BOT_ID'];
  delete process.env['WB_APPROVAL_SESSION_ID'];
  delete process.env['WB_APPROVAL_USER_OPEN_ID'];
  delete process.env['WB_APPROVAL_THREAD_ID'];
  delete process.env['WB_APPROVAL_SOURCE_MESSAGE_ID'];
  delete process.env['WB_APPROVAL_REPLY_MESSAGE_ID'];
  delete process.env['WB_APPROVAL_AGENT_ID'];
  delete process.env['WB_APPROVAL_CODE_OWNER_CONFIG_PATH'];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('writeToMainBranch fixed-config routing', () => {
  it('creates an approval request with owner + configured code owner when config is valid', () => {
    const root = mkRoot();
    const configPath = join(root, 'approval-codeowners.json');
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      repositories: [{
        repoRoot: root,
        branches: [{
          name: 'main',
          rules: [{ paths: ['apps/**'], codeOwnerOpenIds: ['ou_code_owner_1'] }],
        }],
      }],
    }, null, 2));
    chmodSync(configPath, 0o600);

    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const gitRunner = (args: string[]) => {
      if (args.join(' ') === 'rev-parse --show-toplevel') return root;
      if (args.join(' ') === 'diff --name-only HEAD^ HEAD') return 'apps/wb-bot/src/main.ts';
      throw new Error('unexpected git call');
    };

    runApprovalHook({
      WB_DATA_DIR: root,
      WB_APPROVAL_RUN_ID: 'run-main-1',
      WB_APPROVAL_BOT_ID: 'default',
      WB_APPROVAL_SESSION_ID: 'default:ou_owner:grp',
      WB_APPROVAL_USER_OPEN_ID: 'ou_owner',
      WB_APPROVAL_THREAD_ID: 'grp',
      WB_APPROVAL_SOURCE_MESSAGE_ID: 'm1',
      WB_APPROVAL_REPLY_MESSAGE_ID: 'r1',
      WB_APPROVAL_AGENT_ID: 'claude-code',
      WB_APPROVAL_CODE_OWNER_CONFIG_PATH: configPath,
    }, {
      cwd: root,
      tool_name: 'Bash',
      tool_input: { command: 'git push origin HEAD:main' },
    }, { skipWait: true, gitRunner });

    const pending = new ApprovalRequestStore(root).listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.anchor).toBe('writeToMainBranch');
    expect(pending[0]?.allowedApproverOpenIds).toEqual(['ou_code_owner_1', 'ou_owner']);
  });

  it('fails closed when config is missing for writeToMainBranch', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);

    expect(() => runApprovalHook({
      WB_DATA_DIR: mkRoot(),
      WB_APPROVAL_RUN_ID: 'run-main-2',
      WB_APPROVAL_BOT_ID: 'default',
      WB_APPROVAL_SESSION_ID: 'default:ou_owner:grp',
      WB_APPROVAL_USER_OPEN_ID: 'ou_owner',
      WB_APPROVAL_THREAD_ID: 'grp',
      WB_APPROVAL_SOURCE_MESSAGE_ID: 'm1',
      WB_APPROVAL_REPLY_MESSAGE_ID: 'r1',
      WB_APPROVAL_AGENT_ID: 'claude-code',
    }, {
      cwd: '/repo',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin HEAD:main' },
    })).toThrow('exit');

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('approval code owner config path is missing'));
  });
});
