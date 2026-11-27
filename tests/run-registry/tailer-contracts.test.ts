import { describe, expect, it } from 'vitest';
import {
  RUN_STATUS,
  RUN_REGISTRY_ERROR_CODES,
  RunInheritSpecSchema,
  RunQuerySchema,
  RunRecordSchema,
  RunRegistryConfigSchema,
  RunRegistryError,
  RunUpsertedSchema,
} from '../../packages/core/src/run-registry/index.js';

describe('tailer-contracts', () => {
  const validRun = {
    run_id: 'run-001',
    created_at: '2026-06-06T00:00:00.000Z',
    operator: 'ou_abc',
    project: 'bot_thread',
    cwd: '/repo',
    scope: 'normal',
    agent: 'claude-code',
    cmd: 'claude-code --model x',
    status: 'active',
    cost_tokens: null,
    cost_minutes: 1,
    produced_doc_urls: ['https://example.larkoffice.com/docx/abc123'],
    commit_shas: ['0123456789abcdef0123456789abcdef01234567'],
    doc_sink_failed: false,
    calendar_block_id: null,
    calendar_hook_failed: false,
    risk_level: 'unknown',
    home_group_id: 'grp-001',
    entry_form: 'im',
  } as const;

  it('exports required contract symbols', () => {
    expect(RUN_STATUS.PENDING).toBe('pending');
    expect(typeof RunRegistryError).toBe('function');
    expect(RUN_REGISTRY_ERROR_CODES.E_CFG_MISSING).toBe('registry.config.missing');
  });

  it('accepts a valid run record and defaulted query/config values', () => {
    expect(RunRecordSchema.parse(validRun)).toMatchObject(validRun);
    expect(RunQuerySchema.parse({}).limit).toBe(20);
    expect(RunRegistryConfigSchema.parse({
      bitable_base_id: 'BAS1',
      bitable_table_id: 'tbl1',
      app_id: 'cli_xxx',
      app_secret: 'secret',
      lark_domain: 'https://open.larkoffice.com',
    }).run_finalize_grace_ms).toBe(30_000);
  });

  it('rejects invalid run records', () => {
    expect(() => RunRecordSchema.parse({ run_id: '' })).toThrow();
    expect(() => RunRecordSchema.parse({ ...validRun, status: 'invalid' })).toThrow();
    expect(() => RunRecordSchema.parse({ ...validRun, produced_doc_urls: ['not-a-url'] })).toThrow();
  });

  it('parses run upserted idempotency fields', () => {
    const event = RunUpsertedSchema.parse({
      event: 'RunUpserted',
      run_id: 'run-001',
      session_id: 'session-001',
      revision: 0,
      status: 'active',
      cost_tokens: null,
      cost_minutes: null,
      produced_doc_urls: [],
      commit_shas: [],
      doc_sink_failed: false,
      calendar_block_id: null,
      calendar_hook_failed: false,
      updated_at: '2026-06-06T00:00:00.000Z',
    });
    expect(event.run_id).toBe('run-001');
    expect(event.revision).toBe(0);
  });

  it('parses inherit spec allowlist only', () => {
    const spec = RunInheritSpecSchema.parse({
      from_run_id: 'run-001',
      inherit_fields: ['project', 'cwd', 'scope', 'agent', 'home_group_id', 'entry_form'],
      new_run_id: 'run-002',
    });
    expect(spec.inherit_fields).toHaveLength(6);
  });
});
