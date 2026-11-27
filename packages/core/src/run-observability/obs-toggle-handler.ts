import { randomUUID } from 'node:crypto';
import type { AuditRecord } from '../audit-pipe/contracts.js';
import { createMirrorSink } from '../audit-pipe/mirror-sink.js';
import { type ObservabilityStoreEntry } from './contracts.js';

export function toggleAlert(entry: ObservabilityStoreEntry, enabled: boolean): ObservabilityStoreEntry {
  return { ...entry, alert_enabled: enabled };
}

export function writeToggleAudit(dataDir: string, entry: ObservabilityStoreEntry, enabled: boolean): void {
  const sink = createMirrorSink({ dataDir });
  const record: AuditRecord = {
    audit_record_id: randomUUID(),
    session_id: entry.session_id,
    run_id: entry.run_id,
    revision: 0,
    actor: entry.session_id,
    action: 'network_call',
    resource: `run-observability:toggle:${entry.run_id}:alert:${enabled}`,
    ts: new Date().toISOString(),
    entry_form: 'im',
    entry_detail: {
      source_message_id: entry.origin_message_id ?? entry.run_id,
      user_open_id: entry.session_id,
      thread_id: entry.home_group_id ?? entry.card_message_id ?? '',
    },
    agent_id: 'claude-code',
    raw_tool_use_id: `${entry.run_id}:toggle:${enabled}`,
    raw_tool_name: 'obs-toggle',
  };
  sink.write(record);
}
