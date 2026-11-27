import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveDataDir(opts: { dataDir?: string } = {}): string {
  return resolve(opts.dataDir ?? process.env['WB_DATA_DIR'] ?? join(homedir(), '.weaverbird'));
}

export function runsRootDir(dataDir: string): string {
  return join(dataDir, 'runs');
}

export function runsDir(dataDir: string, botId = 'default'): string {
  return join(runsRootDir(dataDir), botId);
}

export function runDir(dataDir: string, runId: string, botId = 'default'): string {
  return join(runsDir(dataDir, botId), runId);
}

export function observabilityDir(dataDir: string, runId: string, botId = 'default'): string {
  return runDir(dataDir, runId, botId);
}

export function runSpecPath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'spec.json');
}

export function runStatusPath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'status');
}

export function runHeartbeatPath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'heartbeat');
}

export function runEventsPath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'events.ndjson');
}

export function runPidPath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'pid');
}

export function runOutputLogPath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'output.log');
}

export function runErrorLogPath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'output.err');
}

export function runStopSignalPath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'stop.signal');
}

export function configDir(dataDir: string): string {
  return join(dataDir, 'config');
}

export function configFile(dataDir: string, domain: string): string {
  return join(configDir(dataDir), `${domain}.json`);
}

export function legacyConfigJsonPath(dataDir: string): string {
  return join(dataDir, 'config.json');
}

export function botHeartbeatPath(dataDir: string, botId: string): string {
  return join(runsDir(dataDir, botId), 'heartbeat');
}

export function botHeartbeatTempPath(dataDir: string, botId: string): string {
  return join(runsDir(dataDir, botId), '.heartbeat.tmp');
}

export function runAuditOffsetPath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'audit-offset');
}

export function runDocSinkStatePath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'doc-sink.json');
}

export function runDocFallbackPath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'doc-fallback.md');
}

export function runDocSinkLockPath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'doc-sink.lock');
}

export function runCalendarHookStatePath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'calendar-hook.json');
}

export function calendarHookDir(dataDir: string): string {
  return join(dataDir, 'calendar-hook');
}

export function calendarTriggerStatePath(dataDir: string): string {
  return join(calendarHookDir(dataDir), 'trigger-state.json');
}

export function calendarRunStateChangedPath(dataDir: string): string {
  return join(calendarHookDir(dataDir), 'run-state-changed.ndjson');
}

export function calendarMockTriggersPath(dataDir: string): string {
  return join(calendarHookDir(dataDir), 'mock-triggers.json');
}

export function groupSyncDir(dataDir: string): string {
  return join(dataDir, 'group-sync');
}

export function groupSyncDispatchStatePath(dataDir: string): string {
  return join(groupSyncDir(dataDir), 'dispatch-state.json');
}

export function groupSyncMockCommandsPath(dataDir: string): string {
  return join(groupSyncDir(dataDir), 'mock-commands.json');
}

export function groupSyncMockLedgerPath(dataDir: string): string {
  return join(groupSyncDir(dataDir), 'mock-sync.ndjson');
}

export function runGroupSyncStatePath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'group-sync.json');
}

export function periodicTasksDir(dataDir: string): string {
  return join(dataDir, 'periodic-tasks');
}

export function periodicTasksStatePath(dataDir: string): string {
  return join(periodicTasksDir(dataDir), 'state.json');
}

export function periodicOccurrenceLedgerPath(dataDir: string): string {
  return join(periodicTasksDir(dataDir), 'occurrence-ledger.ndjson');
}

export function runPeriodicTaskStatePath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'periodic-task.json');
}

export function captainDir(dataDir: string): string {
  return join(dataDir, 'captain');
}

export function captainQueuePath(dataDir: string): string {
  return join(captainDir(dataDir), 'queue.ndjson');
}

export function captainQueueMetricsPath(dataDir: string): string {
  return join(captainDir(dataDir), 'queue-metrics.ndjson');
}

export function captainStatePath(dataDir: string): string {
  return join(dataDir, 'captain-state.ndjson');
}

export function captainSocketPath(dataDir: string): string {
  return join(dataDir, 'captain.sock');
}

export function adminAlertsPath(dataDir: string): string {
  return join(dataDir, 'admin-alerts.ndjson');
}

export function botDbPath(dataDir: string): string {
  return join(dataDir, 'wb-bot.db');
}

export function botLogPath(dataDir: string, botId: string): string {
  return join(dataDir, 'logs', botId, 'wb-bot.log');
}

export function auditMirrorPath(dataDir: string): string {
  return join(dataDir, 'audit-mirror.ndjson');
}

export function auditRejectedPath(dataDir: string): string {
  return join(dataDir, 'audit-rejected.ndjson');
}

export function approvalGateDir(dataDir: string): string {
  return join(dataDir, 'approval-gate');
}

export function approvalRequestsPath(dataDir: string): string {
  return join(approvalGateDir(dataDir), 'requests.ndjson');
}

export function approvalResolutionPath(dataDir: string, requestId: string): string {
  return join(approvalGateDir(dataDir), 'resolutions', `${requestId}.json`);
}

export function auditWalDir(dataDir: string): string {
  return join(dataDir, 'wal', 'audit');
}

export function runRegistryWalDir(dataDir: string): string {
  return join(dataDir, 'wal', 'run-registry');
}

export function captainSessionsWalDir(dataDir: string): string {
  return join(dataDir, 'wal', 'captain-sessions');
}
