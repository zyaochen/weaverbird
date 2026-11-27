import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runGroupSyncStatePath } from '../paths.js';
import { GroupSyncCommandReceivedSchema, GroupSyncStateSchema, type GroupSyncCommandReceived, type GroupSyncConfig, type GroupSyncState, type GroupSyncTransport } from './contracts.js';
import { withTimeout } from './transport.js';

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function readState(path: string, input: GroupSyncCommandReceived): GroupSyncState {
  if (!existsSync(path)) {
    return GroupSyncStateSchema.parse({
      request_id: input.request_id,
      session_id: input.session_id,
      run_id: input.run_id,
      revision: input.revision,
      thread_id: input.thread_id ?? null,
      message_id: input.message_id ?? null,
      scheduled_at: input.scheduled_at,
      last_synced_at: null,
      sync_failed: false,
      last_error: null,
      updated_at: new Date().toISOString(),
    });
  }
  return GroupSyncStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function writeState(path: string, state: GroupSyncState): void {
  atomicWrite(path, JSON.stringify(state, null, 2));
}

export type SyncGroupCommandOptions = {
  dataDir: string;
  botId?: string;
  command: GroupSyncCommandReceived;
  config: GroupSyncConfig;
  transport: GroupSyncTransport;
};

export type GroupSyncResult = {
  sync_failed: boolean;
  state: GroupSyncState;
};

export async function syncGroupCommand(options: SyncGroupCommandOptions): Promise<GroupSyncResult> {
  const command = GroupSyncCommandReceivedSchema.parse(options.command);
  const statePath = runGroupSyncStatePath(options.dataDir, command.run_id, options.botId ?? 'default');
  const state = readState(statePath, command);

  if (
    state.run_id === command.run_id
    && state.revision >= command.revision
    && state.request_id === command.request_id
    && state.last_synced_at !== null
    && state.sync_failed === false
  ) {
    return { sync_failed: false, state };
  }

  try {
    await withTimeout(options.transport.syncCommand(command), options.config.rpc_timeout_ms, 'group sync timeout');
    const nextState = GroupSyncStateSchema.parse({
      request_id: command.request_id,
      session_id: command.session_id,
      run_id: command.run_id,
      revision: command.revision,
      thread_id: command.thread_id ?? null,
      message_id: command.message_id ?? null,
      scheduled_at: command.scheduled_at,
      last_synced_at: new Date().toISOString(),
      sync_failed: false,
      last_error: null,
      updated_at: new Date().toISOString(),
    });
    writeState(statePath, nextState);
    return { sync_failed: false, state: nextState };
  } catch (error) {
    const nextState = GroupSyncStateSchema.parse({
      request_id: command.request_id,
      session_id: command.session_id,
      run_id: command.run_id,
      revision: command.revision,
      thread_id: command.thread_id ?? null,
      message_id: command.message_id ?? null,
      scheduled_at: command.scheduled_at,
      last_synced_at: null,
      sync_failed: true,
      last_error: error instanceof Error ? error.message : String(error),
      updated_at: new Date().toISOString(),
    });
    writeState(statePath, nextState);
    return { sync_failed: true, state: nextState };
  }
}

