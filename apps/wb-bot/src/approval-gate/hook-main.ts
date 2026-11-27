import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchApprovalGate } from '../../../../packages/core/src/approval-gate/matcher.js';
import { APPROVAL_REQUEST_STATUS } from '../../../../packages/core/src/approval-gate/contracts.js';
import { ApprovalRequestStore, readApprovalResolution } from './store.js';
import { writeApprovalAudit } from './audit.js';
import { loadApprovalCodeOwnerConfig, resolveConfiguredCodeOwners } from '../config/approval-code-owners.js';

type HookPayload = {
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
};

const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/;

export function shellCommand(input: unknown): string {
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === 'string' ? command : '';
}

/**
 * M12-F (2026-08-04 owner-authorized): envVarChange / externalDepUpgrade 的 approver
 * 不应该是触发者本身 (userOpenId), 应该是 config 表里的 owner/admin。
 * 通过 env `WB_APPROVAL_ADMIN_OPEN_IDS` (逗号分隔 ou_*) 读；为空时回退到 [userOpenId]
 * 并在 stderr 留 warn 提示配置缺失 (不 deny,以免 block 合法流程)。
 */
export function resolveAdminApproverOpenIds(env: NodeJS.ProcessEnv, fallbackUserOpenId: string): { approvers: string[]; fallbackNote: string | null } {
  const raw = env['WB_APPROVAL_ADMIN_OPEN_IDS'] ?? '';
  const ids = raw.split(',').map((value) => value.trim()).filter((value) => value && OPEN_ID_PATTERN.test(value));
  if (ids.length === 0) {
    return {
      approvers: [fallbackUserOpenId],
      fallbackNote: 'WB_APPROVAL_ADMIN_OPEN_IDS missing/unset — falling back to [userOpenId]; approval from the requester is a degenerate case, configure the owner set before production.',
    };
  }
  return { approvers: [...new Set(ids)].sort(), fallbackNote: null };
}


export function gitStdout(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
  }
  return result.stdout.trim();
}

export function resolveWriteToMainBranchApprovers(
  cwd: string,
  userOpenId: string,
  env: NodeJS.ProcessEnv = process.env,
  gitRunner: (args: string[], runnerCwd: string) => string = gitStdout,
): string[] {
  const configPath = env['WB_APPROVAL_CODE_OWNER_CONFIG_PATH'];
  if (!configPath) throw new Error('approval code owner config path is missing');
  const config = loadApprovalCodeOwnerConfig({ configPath, env });
  const repoRoot = gitRunner(['rev-parse', '--show-toplevel'], cwd);
  const changedRaw = gitRunner(['diff', '--name-only', 'HEAD^', 'HEAD'], cwd);
  const changedPaths = changedRaw.split('\n').map((line) => line.trim()).filter(Boolean);
  if (changedPaths.length === 0) {
    throw new Error('unable to determine changed paths for writeToMainBranch');
  }
  const codeOwners = resolveConfiguredCodeOwners(config, {
    repoRoot,
    branch: 'main',
    changedPaths,
  });
  return [...new Set([userOpenId, ...codeOwners])].sort();
}

export function readPayload(raw = readFileSync(0, 'utf8')): HookPayload {
  return JSON.parse(raw) as HookPayload;
}

function deny(reason: string): never {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

export function runApprovalHook(
  env: NodeJS.ProcessEnv = process.env,
  payload = readPayload(),
  options: { skipWait?: boolean; gitRunner?: (args: string[], runnerCwd: string) => string } = {},
): void {
  const dataDir = env['WB_DATA_DIR'];
  const runId = env['WB_APPROVAL_RUN_ID'];
  const botId = env['WB_APPROVAL_BOT_ID'];
  const sessionId = env['WB_APPROVAL_SESSION_ID'];
  const userOpenId = env['WB_APPROVAL_USER_OPEN_ID'];
  const threadId = env['WB_APPROVAL_THREAD_ID'];
  const sourceMessageId = env['WB_APPROVAL_SOURCE_MESSAGE_ID'];
  const replyMessageId = env['WB_APPROVAL_REPLY_MESSAGE_ID'];
  const agentId = env['WB_APPROVAL_AGENT_ID'];
  if (!dataDir || !runId || !botId || !sessionId || !userOpenId || !threadId || !sourceMessageId || !replyMessageId || !agentId) {
    deny('approval gate misconfigured');
  }

  const toolName = payload.tool_name ?? '';
  const toolInput = payload.tool_input;
  const match = matchApprovalGate(toolName, toolInput);
  if (!match) {
    process.exit(0);
  }

  let allowedApproverOpenIds = [userOpenId];
  if (match.anchor === 'writeToMainBranch') {
    try {
      allowedApproverOpenIds = resolveWriteToMainBranchApprovers(payload.cwd ?? process.cwd(), userOpenId, env, options.gitRunner);
    } catch (error) {
      deny(error instanceof Error ? error.message : String(error));
    }
  } else if (match.anchor === 'envVarChange' || match.anchor === 'externalDepUpgrade') {
    const resolved = resolveAdminApproverOpenIds(env, userOpenId);
    allowedApproverOpenIds = resolved.approvers;
    if (resolved.fallbackNote) {
      process.stderr.write(`[approval-gate] ${resolved.fallbackNote}\n`);
    }
  }

  const store = new ApprovalRequestStore(dataDir);
  const request = store.create({
    runId,
    botId,
    sessionId,
    userOpenId,
    threadId,
    sourceMessageId,
    replyMessageId,
    agentId,
    cwd: payload.cwd ?? process.cwd(),
    match,
    allowedApproverOpenIds,
  });
  writeApprovalAudit({ dataDir, request, phase: 'created' });
  const dispatched = store.markDispatched(request.requestId, 'group_card');
  writeApprovalAudit({ dataDir, request: dispatched, phase: 'dispatched' });

  if (options.skipWait) {
    return;
  }

  while (true) {
    const resolution = readApprovalResolution(dataDir, request.requestId);
    if (!resolution) {
      const expired = store.expireOverdue();
      const matching = expired.find((entry) => entry.requestId === request.requestId);
      if (matching) {
        writeApprovalAudit({ dataDir, request: matching, phase: 'resolved' });
        deny(matching.resolutionReason ?? 'approval timeout');
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      continue;
    }
    const resolved = store.get(request.requestId);
    if (resolved) writeApprovalAudit({ dataDir, request: resolved, phase: 'resolved', nowIso: resolution.resolvedAt });
    if (resolution.status === APPROVAL_REQUEST_STATUS.APPROVED) {
      process.exit(0);
    }
    deny(resolution.reason);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runApprovalHook();
}
