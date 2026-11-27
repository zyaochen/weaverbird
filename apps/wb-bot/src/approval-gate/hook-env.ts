import type { FilteredEnv } from '../security/env-whitelist.js';

export type ApprovalHookEnvOptions = {
  dataDir: string;
  runId: string;
  botId: string;
  sessionId: string;
  userOpenId: string;
  threadId: string;
  sourceMessageId: string;
  replyMessageId: string;
  agentId: string;
  codeOwnerConfigPath?: string;
};

export function buildApprovalHookEnv(
  baseEnv: FilteredEnv<'agent-cli'>,
  options: ApprovalHookEnvOptions,
): FilteredEnv<'agent-cli'> {
  return {
    ...baseEnv,
    WB_DATA_DIR: options.dataDir,
    WB_APPROVAL_RUN_ID: options.runId,
    WB_APPROVAL_BOT_ID: options.botId,
    WB_APPROVAL_SESSION_ID: options.sessionId,
    WB_APPROVAL_USER_OPEN_ID: options.userOpenId,
    WB_APPROVAL_THREAD_ID: options.threadId,
    WB_APPROVAL_SOURCE_MESSAGE_ID: options.sourceMessageId,
    WB_APPROVAL_REPLY_MESSAGE_ID: options.replyMessageId,
    WB_APPROVAL_AGENT_ID: options.agentId,
    ...(options.codeOwnerConfigPath ? { WB_APPROVAL_CODE_OWNER_CONFIG_PATH: options.codeOwnerConfigPath } : {}),
  } as FilteredEnv<'agent-cli'>;
}
