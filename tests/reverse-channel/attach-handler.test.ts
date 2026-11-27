import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptainService } from '../../packages/core/src/captain/index.js';
import { REVERSE_CHANNEL_ERROR_CODES } from '../../packages/core/src/reverse-channel/contracts.js';
import { handleAttachRequest } from '../../packages/core/src/reverse-channel/attach-handler.js';

const roots: string[] = [];

function writeConfig(dir: string): string {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    captain: {
      bitable_base_id: 'Uq6hb0dUaaYiDQsunHel7EisgWd',
      sessions_table_id: 'tblyqLE52hgNO7UA',
      app_id: 'cli_yyyyyyyyyyyyyyyy',
      app_secret: 'secret-32-characters-000000000000',
      lark_domain: 'LarkSuite',
      captain_state_path: join(dir, 'captain-state.ndjson'),
      captain_toml_path: join(dir, 'captain.json'),
    },
  }, null, 2));
  chmodSync(path, 0o600);
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('attach-handler', () => {
  it('attaches an existing session by updating captain_id and status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-attach-handler-'));
    roots.push(dir);
    writeConfig(dir);
    process.env['WB_DATA_DIR'] = dir;
    const service = new CaptainService({ dataDir: dir });
    service.createSession({
      session_id: 'sid-001',
      captain_id: 'old-captain',
      created_at: '2026-06-07T00:00:00.000Z',
      last_active_at: '2026-06-07T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: 'run-001',
      operator: 'ou_abc',
      entry_form: 'im',
    });

    const result = await handleAttachRequest(service, {
      session_id: 'sid-001',
      requester_captain_id: 'default',
      requested_at: '2026-06-07T00:00:01.000Z',
      force: true,
    });

    expect(result.outcome).toBe('attached');
    expect(service.getSession('sid-001')?.record.captain_id).toBe('default');
    expect(service.getSession('sid-001')?.record.status).toBe('active');
  });

  it('returns mutex_conflict when session is owned by another captain without force', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-attach-handler-'));
    roots.push(dir);
    writeConfig(dir);
    process.env['WB_DATA_DIR'] = dir;
    const service = new CaptainService({ dataDir: dir });
    service.createSession({
      session_id: 'sid-001', captain_id: 'other-captain', created_at: '2026-06-07T00:00:00.000Z', last_active_at: '2026-06-07T00:00:00.000Z', cwd: '/repo', scope: 'dev', project: 'weaverbird', home_group_id: 'grp', agent: 'claude-code', latest_run_id: null, operator: 'ou_abc', entry_form: 'im',
    });
    const result = await handleAttachRequest(service, {
      session_id: 'sid-001', requester_captain_id: 'default', requested_at: '2026-06-07T00:00:01.000Z', force: false,
    });
    expect(result.outcome).toBe('mutex_conflict');
  });

  it('returns not_found with empty candidates when target session does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-attach-handler-'));
    roots.push(dir);
    writeConfig(dir);
    process.env['WB_DATA_DIR'] = dir;
    const service = new CaptainService({ dataDir: dir });
    service.createSession({
      session_id: 'sid-known', captain_id: 'default', created_at: '2026-06-07T00:00:00.000Z', last_active_at: '2026-06-07T00:00:00.000Z', cwd: '/repo', scope: 'dev', project: 'weaverbird', home_group_id: 'grp', agent: 'claude-code', latest_run_id: null, operator: 'ou_abc', entry_form: 'im',
    });
    const result = await handleAttachRequest(service, {
      session_id: 'sid-missing', requester_captain_id: 'default', requested_at: '2026-06-07T00:00:01.000Z', force: false,
    });
    expect(result.outcome).toBe('not_found');
    if (result.outcome === 'not_found') {
      expect(result.candidates).toEqual([]);
    }
  });

  it('surfaces flush failure as E_ATTACH_FLUSH_FAILED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-attach-handler-'));
    roots.push(dir);
    writeConfig(dir);
    process.env['WB_DATA_DIR'] = dir;
    const service = new CaptainService({ dataDir: dir });
    service.createSession({
      session_id: 'sid-001', captain_id: 'old-captain', created_at: '2026-06-07T00:00:00.000Z', last_active_at: '2026-06-07T00:00:00.000Z', cwd: '/repo', scope: 'dev', project: 'weaverbird', home_group_id: 'grp', agent: 'claude-code', latest_run_id: 'run-001', operator: 'ou_abc', entry_form: 'im',
    });
    vi.spyOn(service, 'flush').mockRejectedValue(new Error('bitable down'));
    await expect(handleAttachRequest(service, {
      session_id: 'sid-001', requester_captain_id: 'default', requested_at: '2026-06-07T00:00:01.000Z', force: true,
    })).rejects.toMatchObject({ code: REVERSE_CHANNEL_ERROR_CODES.E_ATTACH_FLUSH_FAILED });
  });
});
