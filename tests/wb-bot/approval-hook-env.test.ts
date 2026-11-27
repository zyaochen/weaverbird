import { describe, expect, it } from 'vitest';
import { buildFilteredEnv } from '../../apps/wb-bot/src/security/env-whitelist.js';
import { buildApprovalHookEnv } from '../../apps/wb-bot/src/approval-gate/hook-env.js';

describe('approval hook env', () => {
  it('reinjects the approval gate metadata needed by the hook into agent env', () => {
    const filtered = buildFilteredEnv('agent-cli', {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/test',
      OPENAI_API_KEY: 'sk-openai',
      WB_DATA_DIR: '/tmp/weaverbird',
      WB_MODE: 'multi-bot',
    }, ['OPENAI_API_KEY']);

    expect(filtered['WB_DATA_DIR']).toBeUndefined();
    expect(filtered['WB_MODE']).toBeUndefined();

    const env = buildApprovalHookEnv(filtered, {
      dataDir: '/tmp/weaverbird',
      runId: 'run-123',
      botId: 'default',
      sessionId: 'default:ou_user:oc_thread',
      userOpenId: 'ou_user',
      threadId: 'oc_thread',
      sourceMessageId: 'om_source',
      replyMessageId: 'om_reply',
      agentId: 'codex',
      codeOwnerConfigPath: '/tmp/approval-codeowners.json',
    });

    expect(env['PATH']).toBe('/usr/bin:/bin');
    expect(env['HOME']).toBe('/Users/test');
    expect(env['OPENAI_API_KEY']).toBe('sk-openai');
    expect(env['WB_DATA_DIR']).toBe('/tmp/weaverbird');
    expect(env['WB_APPROVAL_RUN_ID']).toBe('run-123');
    expect(env['WB_APPROVAL_BOT_ID']).toBe('default');
    expect(env['WB_APPROVAL_SESSION_ID']).toBe('default:ou_user:oc_thread');
    expect(env['WB_APPROVAL_USER_OPEN_ID']).toBe('ou_user');
    expect(env['WB_APPROVAL_THREAD_ID']).toBe('oc_thread');
    expect(env['WB_APPROVAL_SOURCE_MESSAGE_ID']).toBe('om_source');
    expect(env['WB_APPROVAL_REPLY_MESSAGE_ID']).toBe('om_reply');
    expect(env['WB_APPROVAL_AGENT_ID']).toBe('codex');
    expect(env['WB_APPROVAL_CODE_OWNER_CONFIG_PATH']).toBe('/tmp/approval-codeowners.json');
    expect(env['WB_MODE']).toBeUndefined();
  });
});
