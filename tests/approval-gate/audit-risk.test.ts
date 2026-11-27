import { describe, expect, it } from 'vitest';
import type { AuditRecord } from '../../packages/core/src/audit-pipe/contracts.js';
import { deriveApprovalRiskLevel } from '../../packages/core/src/approval-gate/audit.js';

function record(resource: string): AuditRecord {
  return {
    audit_record_id: 'a1',
    session_id: 'sid',
    run_id: 'run-1',
    revision: 0,
    actor: 'ou_1',
    action: 'other',
    resource,
    ts: '2026-06-26T00:00:00.000Z',
    entry_form: 'im',
    entry_detail: { source_message_id: 'm1', user_open_id: 'ou_1', thread_id: 'grp' },
    agent_id: 'claude-code',
    raw_tool_use_id: 'tool-1',
    raw_tool_name: 'approval-gate',
  };
}

describe('approval audit risk derivation', () => {
  it('returns high when approval gate audit exists for env changes', () => {
    expect(deriveApprovalRiskLevel([record('approval-gate:resolved:anchor=envVarChange:result=approved')])).toBe('high');
  });

  it('returns high when approval gate audit exists for dependency upgrades', () => {
    expect(deriveApprovalRiskLevel([record('approval-gate:resolved:anchor=externalDepUpgrade:result=denied')])).toBe('high');
  });

  it('returns high when main-branch writes are blocked by stub', () => {
    expect(deriveApprovalRiskLevel([record('approval-gate:resolved:anchor=writeToMainBranch:result=failed_closed')])).toBe('high');
  });

  it('returns unknown when no approval gate audit exists', () => {
    expect(deriveApprovalRiskLevel([record('run-observability:finalize:run-1')])).toBe('unknown');
  });
});
