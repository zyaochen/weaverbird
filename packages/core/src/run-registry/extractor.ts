import type { AuditRecord } from './contracts.js';
import { deriveApprovalRiskLevel } from '../approval-gate/audit.js';

const SHA_PATTERN = /\b[0-9a-f]{40}\b/g;

function matchesAllowlist(url: URL, rule: string): boolean {
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(1);
    return url.hostname.endsWith(suffix);
  }
  return url.hostname === rule || url.hostname.endsWith(`.${rule}`);
}

export function extractUrls(records: AuditRecord[], allowlist: string[]): string[] {
  const urls = new Set<string>();
  for (const record of records) {
    if (record.action !== 'network_call') continue;
    try {
      const parsed = new URL(record.resource);
      if (allowlist.some((rule) => matchesAllowlist(parsed, rule))) {
        urls.add(parsed.toString());
      }
    } catch {
      continue;
    }
  }
  return [...urls];
}

export function extractShas(records: AuditRecord[]): string[] {
  const shas = new Set<string>();
  for (const record of records) {
    if (record.action !== 'git_op') continue;
    for (const sha of record.resource.match(SHA_PATTERN) ?? []) {
      shas.add(sha);
    }
  }
  return [...shas];
}

export function extractRiskLevel(records: AuditRecord[]): 'unknown' | 'high' {
  return deriveApprovalRiskLevel(records);
}
