import { describe, expect, it } from 'vitest';
import {
  CAPTAIN_ERROR_CODES,
  CaptainConfigSchema,
  CaptainError,
  CaptainMappingSchema,
  CaptainTomlSchema,
  CommandCatalogEntrySchema,
  CwdInferenceResultSchema,
  SESSION_STATUS,
  SessionRecordSchema,
} from '../../packages/core/src/captain/index.js';

describe('captain-contracts', () => {
  const validSession = {
    session_id: 'sid-001',
    captain_id: 'default',
    created_at: '2026-06-06T00:00:00.000Z',
    last_active_at: '2026-06-06T00:00:00.000Z',
    closed_at: null,
    status: 'active',
    cwd: '/repo',
    scope: 'dev',
    project: 'weaverbird',
    home_group_id: 'grp-001',
    agent: 'claude-code',
    latest_run_id: 'run-001',
    operator: 'ou_abc',
    entry_form: 'im',
  } as const;

  it('exports required captain symbols', () => {
    expect(SESSION_STATUS.IDLE).toBe('idle');
    expect(CAPTAIN_ERROR_CODES.E_CATALOG_INCOMPLETE).toBe('captain.catalog.incomplete');
    expect(typeof CaptainError).toBe('function');
  });

  it('accepts a valid session record and captain config', () => {
    expect(SessionRecordSchema.parse(validSession)).toMatchObject(validSession);
    expect(CaptainTomlSchema.parse({ mapping: [{ git_remote: 'github\\.com', captain_id: 'default' }] }).version).toBe(1);
    expect(CaptainConfigSchema.parse({
      bitable_base_id: 'Uq6hb0dUaaYiDQsunHel7EisgWd',
      sessions_table_id: 'tblyqLE52hgNO7UA',
      app_id: 'cli_xxx',
      app_secret: 'secret',
      lark_domain: 'LarkSuite',
      captain_state_path: '~/.weaverbird/captain-state.ndjson',
      captain_toml_path: 'weaverbird-v2/captain.toml',
    }).sessions_table_id).toBe('tblyqLE52hgNO7UA');
  });

  it('rejects invalid session record and mapping', () => {
    expect(() => SessionRecordSchema.parse({ ...validSession, status: 'broken' })).toThrow();
    expect(() => CaptainMappingSchema.parse({ captain_id: 'default' })).toThrow();
  });

  it('parses cwd inference result variants', () => {
    expect(CwdInferenceResultSchema.parse({ outcome: 'hit', captain_id: 'default', matched_by: 'git_remote' }).outcome).toBe('hit');
    expect(CwdInferenceResultSchema.parse({ outcome: 'miss', candidates: ['default'], suggestion: 'run: wb captain use default' }).outcome).toBe('miss');
  });

  it('parses command catalog entry shape', () => {
    const entry = CommandCatalogEntrySchema.parse({
      name: 'status',
      aliases: ['/wb status', 'wb status'],
      belongs_to: 'both',
      capability_tags: ['captain'],
      im_visible: true,
      cli_visible: true,
      description: 'Show session status',
    });
    expect(entry.name).toBe('status');
  });
});
