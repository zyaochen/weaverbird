import { describe, expect, it } from 'vitest';
import { extractShas, extractUrls, type AuditRecord } from '../../packages/core/src/run-registry/index.js';

function makeRecord(partial: Partial<AuditRecord>): AuditRecord {
  return {
    audit_record_id: partial.audit_record_id ?? 'audit-1',
    session_id: partial.session_id ?? 'session-1',
    run_id: partial.run_id ?? 'run-1',
    revision: partial.revision ?? 0,
    actor: partial.actor ?? 'user',
    action: partial.action ?? 'other',
    resource: partial.resource ?? '',
    ts: partial.ts ?? new Date().toISOString(),
    entry_form: partial.entry_form ?? 'im',
    entry_detail: partial.entry_detail ?? { source_message_id: 'm1', user_open_id: 'ou_abc', thread_id: 'thd_001' },
    agent_id: partial.agent_id ?? 'claude-code',
    raw_tool_use_id: partial.raw_tool_use_id ?? 'tool-1',
    raw_tool_name: partial.raw_tool_name ?? 'Tool',
  };
}

describe('extractor', () => {
  const allowlist = ['*.larkoffice.com', '*.feishu.cn', 'github.com'];

  it('includes network_call urls that match allowlist', () => {
    const urls = extractUrls([
      makeRecord({ action: 'network_call', resource: 'https://example.larkoffice.com/docx/abc123' }),
    ], allowlist);
    expect(urls).toContain('https://example.larkoffice.com/docx/abc123');
  });

  it('excludes urls that do not match allowlist', () => {
    const urls = extractUrls([
      makeRecord({ action: 'network_call', resource: 'https://example.com/page' }),
    ], allowlist);
    expect(urls).toHaveLength(0);
  });

  it('extracts commit shas from git_op resources', () => {
    const shas = extractShas([
      makeRecord({ action: 'git_op', resource: 'git commit 0123456789abcdef0123456789abcdef01234567' }),
    ]);
    expect(shas).toContain('0123456789abcdef0123456789abcdef01234567');
  });

  it('ignores git_op resources without shas', () => {
    const shas = extractShas([
      makeRecord({ action: 'git_op', resource: 'git push origin main' }),
    ]);
    expect(shas).toHaveLength(0);
  });

  it('extracts only target events from mixed event streams', () => {
    const records = [
      makeRecord({ action: 'network_call', resource: 'https://foo.larkoffice.com/docx/1' }),
      makeRecord({ action: 'network_call', resource: 'https://www.feishu.cn/docx/2', revision: 1, raw_tool_use_id: 'tool-2' }),
      makeRecord({ action: 'git_op', resource: 'git commit abc 0123456789abcdef0123456789abcdef01234567', revision: 2, raw_tool_use_id: 'tool-3' }),
      ...Array.from({ length: 7 }, (_, index) => makeRecord({ action: 'file_read', resource: `/tmp/${index}`, revision: index + 3, raw_tool_use_id: `tool-x-${index}` })),
    ];
    expect(extractUrls(records, allowlist)).toHaveLength(2);
    expect(extractShas(records)).toHaveLength(1);
  });

  it('deduplicates repeated urls', () => {
    const url = 'https://foo.larkoffice.com/docx/repeat';
    const urls = extractUrls([
      makeRecord({ action: 'network_call', resource: url }),
      makeRecord({ action: 'network_call', resource: url, revision: 1, raw_tool_use_id: 'tool-2' }),
      makeRecord({ action: 'network_call', resource: url, revision: 2, raw_tool_use_id: 'tool-3' }),
    ], allowlist);
    expect(urls).toEqual([url]);
  });
});
