import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adminAlertsPath,
  auditMirrorPath,
  auditRejectedPath,
  auditWalDir,
  botDbPath,
  calendarHookDir,
  calendarMockTriggersPath,
  calendarRunStateChangedPath,
  calendarTriggerStatePath,
  botHeartbeatPath,
  botHeartbeatTempPath,
  botLogPath,
  captainQueueMetricsPath,
  captainQueuePath,
  captainSessionsWalDir,
  captainSocketPath,
  captainStatePath,
  configDir,
  configFile,
  legacyConfigJsonPath,
  observabilityDir,
  resolveDataDir,
  runAuditOffsetPath,
  runDir,
  runCalendarHookStatePath,
  runDocFallbackPath,
  runDocSinkLockPath,
  runDocSinkStatePath,
  runErrorLogPath,
  runEventsPath,
  runHeartbeatPath,
  runOutputLogPath,
  runPidPath,
  runRegistryWalDir,
  runSpecPath,
  runStatusPath,
  runStopSignalPath,
  runsDir,
  runsRootDir,
} from '../../packages/core/src/paths.js';

describe('T1-paths-basic', () => {
  it('runsDir returns bot-scoped runs directory', () => {
    expect(runsDir('/data', 'bot-a')).toBe('/data/runs/bot-a');
  });

  it('runDir returns run directory under bot runs directory', () => {
    expect(runDir('/data', 'run-1', 'bot-a')).toBe('/data/runs/bot-a/run-1');
  });

  it('observabilityDir follows existing W3.4 run directory layout', () => {
    expect(observabilityDir('/data', 'run-1', 'bot-a')).toBe('/data/runs/bot-a/run-1');
  });

  it('configDir returns config directory', () => {
    expect(configDir('/data')).toBe('/data/config');
  });

  it('configFile returns domain json file under config directory', () => {
    expect(configFile('/data', 'captain')).toBe('/data/config/captain.json');
  });

  it('normalizes dataDir with trailing slash for runsDir', () => {
    expect(runsDir('/data/', 'bot-a')).toBe('/data/runs/bot-a');
  });

  it('normalizes dataDir with trailing slash for configFile', () => {
    expect(configFile('/data/', 'captain')).toBe('/data/config/captain.json');
  });

  it('resolveDataDir prefers explicit dataDir over environment', () => {
    process.env['WB_DATA_DIR'] = '/env-data';
    expect(resolveDataDir({ dataDir: '/explicit-data' })).toBe('/explicit-data');
    delete process.env['WB_DATA_DIR'];
  });

  it('resolveDataDir falls back to WB_DATA_DIR and then ~/.weaverbird', () => {
    process.env['WB_DATA_DIR'] = '/env-data';
    expect(resolveDataDir()).toBe('/env-data');
    process.env['WB_DATA_DIR'] = './relative-data';
    expect(resolveDataDir()).toBe(resolvePath('./relative-data'));
    delete process.env['WB_DATA_DIR'];
    expect(resolveDataDir()).toBe(resolvePath(homedir(), '.weaverbird'));
  });

  it('resolveDataDir normalizes explicit trailing slash', () => {
    expect(resolveDataDir({ dataDir: '/data/' })).toBe('/data');
  });

  it('exposes run file helpers under the existing run layout', () => {
    expect(runsRootDir('/data')).toBe('/data/runs');
    expect(runSpecPath('/data', 'run-1', 'bot-a')).toBe('/data/runs/bot-a/run-1/spec.json');
    expect(runStatusPath('/data', 'run-1', 'bot-a')).toBe('/data/runs/bot-a/run-1/status');
    expect(runHeartbeatPath('/data', 'run-1', 'bot-a')).toBe('/data/runs/bot-a/run-1/heartbeat');
    expect(runEventsPath('/data', 'run-1', 'bot-a')).toBe('/data/runs/bot-a/run-1/events.ndjson');
    expect(runPidPath('/data', 'run-1', 'bot-a')).toBe('/data/runs/bot-a/run-1/pid');
    expect(runOutputLogPath('/data', 'run-1', 'bot-a')).toBe('/data/runs/bot-a/run-1/output.log');
    expect(runErrorLogPath('/data', 'run-1', 'bot-a')).toBe('/data/runs/bot-a/run-1/output.err');
    expect(runStopSignalPath('/data', 'run-1', 'bot-a')).toBe('/data/runs/bot-a/run-1/stop.signal');
    expect(runAuditOffsetPath('/data', 'run-1', 'bot-a')).toBe('/data/runs/bot-a/run-1/audit-offset');
    expect(runCalendarHookStatePath('/data', 'run-1', 'bot-a')).toBe('/data/runs/bot-a/run-1/calendar-hook.json');
    expect(runDocSinkStatePath('/data', 'run-1', 'bot-a')).toBe('/data/runs/bot-a/run-1/doc-sink.json');
    expect(runDocFallbackPath('/data', 'run-1', 'bot-a')).toBe('/data/runs/bot-a/run-1/doc-fallback.md');
    expect(runDocSinkLockPath('/data', 'run-1', 'bot-a')).toBe('/data/runs/bot-a/run-1/doc-sink.lock');
    expect(botHeartbeatPath('/data', 'bot-a')).toBe('/data/runs/bot-a/heartbeat');
    expect(botHeartbeatTempPath('/data', 'bot-a')).toBe('/data/runs/bot-a/.heartbeat.tmp');
  });

  it('exposes captain and bot artifact helpers under the shared data root', () => {
    expect(calendarHookDir('/data')).toBe('/data/calendar-hook');
    expect(calendarTriggerStatePath('/data')).toBe('/data/calendar-hook/trigger-state.json');
    expect(calendarRunStateChangedPath('/data')).toBe('/data/calendar-hook/run-state-changed.ndjson');
    expect(calendarMockTriggersPath('/data')).toBe('/data/calendar-hook/mock-triggers.json');
    expect(captainQueuePath('/data')).toBe('/data/captain/queue.ndjson');
    expect(captainQueueMetricsPath('/data')).toBe('/data/captain/queue-metrics.ndjson');
    expect(captainStatePath('/data')).toBe('/data/captain-state.ndjson');
    expect(captainSocketPath('/data')).toBe('/data/captain.sock');
    expect(adminAlertsPath('/data')).toBe('/data/admin-alerts.ndjson');
    expect(botDbPath('/data')).toBe('/data/wb-bot.db');
    expect(botLogPath('/data', 'bot-a')).toBe('/data/logs/bot-a/wb-bot.log');
    expect(auditMirrorPath('/data')).toBe('/data/audit-mirror.ndjson');
    expect(auditRejectedPath('/data')).toBe('/data/audit-rejected.ndjson');
    expect(auditWalDir('/data')).toBe('/data/wal/audit');
    expect(runRegistryWalDir('/data')).toBe('/data/wal/run-registry');
    expect(captainSessionsWalDir('/data')).toBe('/data/wal/captain-sessions');
    expect(legacyConfigJsonPath('/data')).toBe('/data/config.json');
  });
});
