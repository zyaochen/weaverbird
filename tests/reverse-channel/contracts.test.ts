import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as reverseChannel from '../../packages/core/src/reverse-channel/contracts.js';

describe('reverse-channel/contracts', () => {
  it('exports the required schemas, types, constants, and error class', () => {
    const expected = [
      'IPC_SOCKET_PATH',
      'ECHO_DEDUP_WINDOW_MS',
      'ATTACH_TIMEOUT_MS',
      'HEARTBEAT_INTERVAL_MS',
      'REVERSE_AT_PREFIX',
      'REVERSE_AT_PATTERN',
      'REVERSE_CHANNEL_AUDIT_RESOURCE_PREFIX',
      'ECHO_CMD_PREVIEW_MAX',
      'ECHO_MAX_PER_RUN',
      'REVERSE_COMMAND',
      'AttachRequestSchema',
      'AttachResultSchema',
      'EchoPayloadSchema',
      'ReverseAtCommandSchema',
      'IpcMessageSchema',
      'REVERSE_CHANNEL_ERROR_CODES',
      'ReverseChannelError',
    ];
    expected.forEach((name) => expect(reverseChannel).toHaveProperty(name));
  });

  it('parses representative IPC and attach payloads', () => {
    expect(reverseChannel.AttachRequestSchema.parse({
      session_id: 'sid-001',
      requester_captain_id: 'default',
      requested_at: '2026-06-07T00:00:00.000Z',
    }).force).toBe(false);

    expect(reverseChannel.IpcMessageSchema.parse({ kind: 'hello', run_id: 'run-001', pid: 1234 }).kind).toBe('hello');
    expect(reverseChannel.ReverseAtCommandSchema.parse({
      command: 'pause',
      run_id: 'run-001',
      requester_open_id: 'ou_abc',
      requested_at: '2026-06-07T00:00:00.000Z',
      message_id: 'om_1',
    }).command).toBe('pause');
  });

  it('runtime contracts diff against SPEC limited to N1+N2 normalization', () => {
    const root = process.cwd();
    const specPath = join(root, 'specs', 'w3.3-wb-cli-console', 'contracts.ts');
    const runtimePath = join(root, 'packages', 'core', 'src', 'reverse-channel', 'contracts.ts');
    const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').trim();
    const spec = readFileSync(specPath, 'utf8');
    const runtime = readFileSync(runtimePath, 'utf8');
    const normalized = runtime
      .replace(/\.\.\/run-registry\/contracts\.js/g, '../../packages/core/src/run-registry/contracts.js')
      .replace(/\.\.\/audit-pipe\/contracts\.js/g, '../../packages/core/src/audit-pipe/contracts.js')
      .replace(/\.\.\/captain\/contracts\.js/g, '../../packages/core/src/captain/contracts.js')
      .replace(/const RUN_STATUS_VALUES = Object\.values\(RUN_STATUS\) as \[string, \.\.\.string\[\]\];\s*/g, '')
      .replace(/z\.enum\(RUN_STATUS_VALUES\)/g, 'z.enum(RUN_STATUS)');
    expect(stripComments(normalized)).toBe(stripComments(spec));
  });
});
