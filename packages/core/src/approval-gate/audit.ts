import type { AuditRecord } from '../audit-pipe/contracts.js';
import { APPROVAL_GATE_ANCHORS } from './contracts.js';

export function deriveApprovalRiskLevel(records: AuditRecord[]): 'unknown' | 'high' {
  for (const record of records) {
    if (record.action !== 'other') continue;
    if (!record.resource.startsWith('approval-gate:')) continue;
    if (record.resource.includes(`anchor=${APPROVAL_GATE_ANCHORS.ENV_VAR_CHANGE}`)) return 'high';
    if (record.resource.includes(`anchor=${APPROVAL_GATE_ANCHORS.EXTERNAL_DEP_UPGRADE}`)) return 'high';
    if (record.resource.includes(`anchor=${APPROVAL_GATE_ANCHORS.WRITE_TO_MAIN_BRANCH}`)) return 'high';
  }
  return 'unknown';
}
