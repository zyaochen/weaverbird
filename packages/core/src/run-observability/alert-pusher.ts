import { randomUUID } from 'node:crypto';
import type { AuditRecord } from '../audit-pipe/contracts.js';
import { createMirrorSink } from '../audit-pipe/mirror-sink.js';
import { RUN_OBSERVABILITY_ERROR_CODES, type AlertPayload, type SessionRecord } from './contracts.js';
import { renderAlertCard } from './alert-card-renderer.js';

export type AlertPusherClient = {
  sendMessage(chatId: string, card: Record<string, unknown>): Promise<void>;
};

export async function pushAlert(
  payload: AlertPayload,
  options: {
    session: Pick<SessionRecord, 'session_id' | 'home_group_id' | 'operator' | 'agent'>;
    dataDir: string;
    client: AlertPusherClient;
    alertEnabled: boolean;
    alreadyAlerted: boolean;
    onAlerted?: () => void;
  },
): Promise<void> {
  const sink = createMirrorSink({ dataDir: options.dataDir });
  const writeAudit = (resource: string, skipped = false) => {
    const record: AuditRecord = {
      audit_record_id: randomUUID(),
      session_id: options.session.session_id,
      run_id: payload.run_id,
      revision: 0,
      actor: options.session.operator,
      action: 'network_call',
      resource,
      ts: new Date().toISOString(),
      entry_form: 'im',
      entry_detail: {
        source_message_id: payload.run_id,
        user_open_id: options.session.operator,
        thread_id: options.session.home_group_id ?? '',
      },
      agent_id: 'claude-code',
      raw_tool_use_id: `${payload.run_id}:${payload.reason}:${skipped ? 'skipped' : 'send'}`,
      raw_tool_name: 'alert-pusher',
    };
    sink.write(record);
  };

  if (options.alreadyAlerted) return;
  if (!options.alertEnabled) {
    writeAudit(`run-observability:alert:${payload.run_id}:${payload.reason}:skipped`, true);
    return;
  }
  if (!options.session.home_group_id) return;

  const card = renderAlertCard(payload, options.session.operator);
  try {
    await options.client.sendMessage(options.session.home_group_id, card);
    options.onAlerted?.();
    writeAudit(`run-observability:alert:${payload.run_id}:${payload.reason}`);
  } catch {
    writeAudit(`run-observability:alert:${payload.run_id}:${payload.reason}:failed`);
    throw new Error(RUN_OBSERVABILITY_ERROR_CODES.E_IM_SEND_FAILED);
  }
}
