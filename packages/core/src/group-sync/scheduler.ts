import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { groupSyncDispatchStatePath, groupSyncMockCommandsPath } from '../paths.js';
import { GroupSyncCommandReceivedSchema, type GroupSyncCommandReceived, type GroupSyncConfig, type GroupSyncTransport } from './contracts.js';
import { createInlineGroupSyncDispatchTransport, dispatchGroupSyncCommand, type GroupSyncDispatchTransport } from './dispatch.js';
import { syncGroupCommand } from './service.js';

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function readCommandRecords(path: string): GroupSyncCommandReceived[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown[];
    return Array.isArray(parsed) ? parsed.map((item) => GroupSyncCommandReceivedSchema.parse(item)) : [];
  } catch {
    return [];
  }
}

function readDispatchState(path: string): Record<string, string | null> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string | null>;
  } catch {
    return {};
  }
}

function writeDispatchState(path: string, state: Record<string, string | null>): void {
  atomicWrite(path, JSON.stringify(state, null, 2));
}

export type GroupSyncScheduler = {
  tick(): Promise<void>;
  stop(): void;
};

export type StartGroupSyncSchedulerOptions = {
  dataDir: string;
  botId?: string;
  config: GroupSyncConfig;
  transport: GroupSyncTransport;
  onCommand: (command: GroupSyncCommandReceived) => Promise<void>;
  dispatchTransport?: GroupSyncDispatchTransport;
  nowFn?: () => number;
};

export function startGroupSyncScheduler(options: StartGroupSyncSchedulerOptions): GroupSyncScheduler {
  const nowFn = options.nowFn ?? Date.now;
  const dispatchTransport = options.dispatchTransport ?? createInlineGroupSyncDispatchTransport(options.onCommand);
  const commandFile = groupSyncMockCommandsPath(options.dataDir);
  const dispatchStateFile = groupSyncDispatchStatePath(options.dataDir);
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const dispatchState = readDispatchState(dispatchStateFile);
      const now = nowFn();
      const nowIso = new Date(now).toISOString();

      for (const record of readCommandRecords(commandFile)) {
        if (Date.parse(record.scheduled_at) > now) continue;
        if (dispatchState[record.request_id]) continue;
        dispatchState[record.request_id] = nowIso;
        writeDispatchState(dispatchStateFile, dispatchState);
        await syncGroupCommand({
          dataDir: options.dataDir,
          botId: options.botId,
          command: record,
          config: options.config,
          transport: options.transport,
        });
        await dispatchGroupSyncCommand({
          dataDir: options.dataDir,
          botId: options.botId,
          command: record,
          transport: dispatchTransport,
          nowFn,
        });
      }
    } finally {
      inFlight = false;
    }
  }

  if (options.config.enabled) {
    timer = setInterval(() => {
      void tick();
    }, options.config.sweep_interval_ms);
    timer.unref?.();
  }

  return {
    tick,
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
