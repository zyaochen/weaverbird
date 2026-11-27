import { describe, expect, it } from 'vitest';
import { normalize, resetNormalizerState } from '../../../packages/core/src/audit-pipe/normalizer.js';
import type { RunSpec, ToolUseEvent } from '../../../packages/core/src/audit-pipe/contracts.js';

const SPEC_IM: RunSpec = {
  runId: 'run-1',
  botId: 'bot-1',
  agentId: 'claude-code',
  userOpenId: 'ou_user_xyz',
  threadId: 'om_thread_abc',
  sourceMessageId: 'om_msg_x',
  replyMessageId: 'om_msg_y',
  cwd: '/tmp/proj',
  model: 'sonnet-4',
  consentLevel: 'normal',
  startedAt: '2026-06-04T09:00:00.000Z',
  schemaVersion: 1,
  host: 'local',
};

const SPEC_CLI: RunSpec = { ...SPEC_IM, sourceMessageId: '' };

function event(name: string, input: unknown, id = 't1'): ToolUseEvent {
  return { type: 'tool_use', id, name, input };
}

describe('T3 normalizer', () => {
  it('maps tool names to EventType', () => {
    resetNormalizerState();
    const read = normalize(event('Read', { file_path: 'a.ts' }), SPEC_IM);
    const write = normalize(event('Write', { file_path: 'b.ts' }, 't2'), SPEC_IM);
    const shell = normalize(event('Bash', { command: 'ls -la' }, 't3'), SPEC_IM);
    const env = normalize(event('Bash', { command: 'echo $HOME' }, 't4'), SPEC_IM);
    const git = normalize(event('Bash', { command: 'git status' }, 't5'), SPEC_IM);
    const net = normalize(event('WebFetch', { url: 'https://example.com' }, 't6'), SPEC_IM);
    const other = normalize(event('CustomTool', {}, 't7'), SPEC_IM);
    if (read.kind === 'audit') expect(read.record.action).toBe('file_read');
    if (write.kind === 'audit') expect(write.record.action).toBe('file_write');
    if (shell.kind === 'audit') expect(shell.record.action).toBe('shell_exec');
    if (env.kind === 'audit') expect(env.record.action).toBe('env_access');
    if (git.kind === 'audit') expect(git.record.action).toBe('git_op');
    if (net.kind === 'audit') expect(net.record.action).toBe('network_call');
    if (other.kind === 'audit') expect(other.record.action).toBe('other');
  });

  it('prefers env_access over git_op when both patterns appear', () => {
    resetNormalizerState();
    const result = normalize(event('Bash', { command: 'git push $TOKEN_URL' }), SPEC_IM);
    expect(result.kind).toBe('audit');
    if (result.kind === 'audit') {
      expect(result.record.action).toBe('env_access');
      // M12-C: env_filter_hit 同步打,让下游 DM/alert 通道可以单独扫这列
      expect(result.record.env_filter_hit).toBe(true);
    }
  });

  it('emits env_filter_hit for $VAR and process.env references even when action is shell_exec/git_op', () => {
    resetNormalizerState();
    const gitWithToken = normalize(event('Bash', { command: 'git push origin main' }), SPEC_IM);
    expect(gitWithToken.kind).toBe('audit');
    if (gitWithToken.kind === 'audit') expect(gitWithToken.record.env_filter_hit).toBeUndefined();

    const processEnv = normalize(event('Bash', { command: 'node -e "console.log(process.env.NODE_ENV)"' }, 't9'), SPEC_IM);
    expect(processEnv.kind).toBe('audit');
    if (processEnv.kind === 'audit') expect(processEnv.record.env_filter_hit).toBe(true);
  });

  it('does not flag pure lowercase shell variables', () => {
    resetNormalizerState();
    const lower = normalize(event('Bash', { command: 'echo $user' }, 't10'), SPEC_IM);
    expect(lower.kind).toBe('audit');
    if (lower.kind === 'audit') expect(lower.record.env_filter_hit).toBeUndefined();
  });


  it('derives entry_form and entry_detail from spec', () => {
    resetNormalizerState();
    const im = normalize(event('Read', { file_path: 'a.ts' }), SPEC_IM);
    const cli = normalize(event('Read', { file_path: 'a.ts' }, 't2'), SPEC_CLI);
    if (im.kind === 'audit') {
      expect(im.record.entry_form).toBe('im');
      expect(im.record.entry_detail).toEqual({ source_message_id: 'om_msg_x', user_open_id: 'ou_user_xyz', thread_id: 'om_thread_abc' });
    }
    if (cli.kind === 'audit') {
      expect(cli.record.entry_form).toBe('cli');
      expect(cli.record.entry_detail).toEqual({ user_open_id: 'ou_user_xyz', host: 'local' });
    }
  });

  it('keeps revision and audit_record_id stable for replayed tool_use ids', () => {
    resetNormalizerState();
    const first = normalize(event('Read', { file_path: 'a.ts' }, 'toolu_X'), SPEC_IM);
    const second = normalize(event('Read', { file_path: 'a.ts' }, 'toolu_X'), SPEC_IM);
    expect(first.kind).toBe('audit');
    expect(second.kind).toBe('audit');
    if (first.kind === 'audit' && second.kind === 'audit') {
      expect(first.record.revision).toBe(second.record.revision);
      expect(first.record.audit_record_id).toBe(second.record.audit_record_id);
    }
  });

  it('increments revision across distinct tool_use ids', () => {
    resetNormalizerState();
    const first = normalize(event('Read', {}, 't1'), SPEC_IM);
    const second = normalize(event('Read', {}, 't2'), SPEC_IM);
    if (first.kind === 'audit' && second.kind === 'audit') {
      expect(second.record.revision).toBeGreaterThan(first.record.revision);
    }
  });

  it('returns rejected record when spec is missing', () => {
    resetNormalizerState();
    const result = normalize(event('Read', { file_path: 'a.ts' }), null);
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.record.reason).toBe('missing_spec');
  });
});
