import { configFile } from '../paths.js';
import { buildRunRecordFromUpserted } from './doc-sink.js';
import { loadRunRegistryConfig, resolveRunRegistryDataDir } from './config.js';
import { createRunRegistryWriter, type CreateRunRegistryWriterOptions, type RunRegistryWriter } from './bitable-writer.js';
import type { DocSinkTransport } from './doc-sink-transport.js';
import { RunTailer } from './tailer.js';

export type StartRunRegistryOptions = CreateRunRegistryWriterOptions & {
  docSinkTransport?: DocSinkTransport;
  _tailerBatchFlushIntervalMs?: number;
  _tailerPollIntervalMs?: number;
  _tailerFinalizeIntervalMs?: number;
};

export interface RunRegistryController {
  reload(): Promise<void>;
  stop(): Promise<void>;
  status(): { walPending: number; lastWriteOk: string | null };
}

type RuntimeState = {
  configPath: string;
  env: NodeJS.ProcessEnv;
  writer: RunRegistryWriter | null;
  tailer: RunTailer | null;
  stopped: boolean;
  lastWriteOk: string | null;
  onSighup: (() => void) | null;
  onSigterm: (() => void) | null;
};

function countWalPending(writer: RunRegistryWriter | null): number {
  return writer?.wal.listFiles().length ?? 0;
}

async function startRuntime(state: RuntimeState, options: StartRunRegistryOptions): Promise<void> {
  const config = loadRunRegistryConfig({ configPath: state.configPath, env: state.env });
  const writer = createRunRegistryWriter(options);
  await writer.validateSchema();
  writer.startSyncWorker();

  const nextTailer = new RunTailer({
    dataDir: resolveRunRegistryDataDir(state.env),
    runFinalizeGraceMs: config.run_finalize_grace_ms,
    config,
    env: state.env,
    docSinkTransport: options.docSinkTransport,
    batchFlushIntervalMs: options._tailerBatchFlushIntervalMs,
    pollIntervalMs: options._tailerPollIntervalMs,
    finalizeIntervalMs: options._tailerFinalizeIntervalMs,
    onRunUpserted: async (event, entry) => {
      const record = buildRunRecordFromUpserted({ event, entry });
      const result = await writer.upsert(record);
      if (result.ok) state.lastWriteOk = new Date().toISOString();
    },
  });

  const previousTailer = state.tailer;
  const previousWriter = state.writer;
  previousTailer?.stop();
  await previousTailer?.waitForIdle();
  previousWriter?.stopSyncWorker();
  state.writer = writer;
  state.tailer = nextTailer;
  nextTailer.start();
}

export async function startRunRegistry(options: StartRunRegistryOptions = {}): Promise<RunRegistryController> {
  const env = options.env ?? process.env;
  const dataDir = resolveRunRegistryDataDir(env);
  const state: RuntimeState = {
    configPath: options.configPath ?? configFile(dataDir, 'run-registry'),
    env,
    writer: null,
    tailer: null,
    stopped: false,
    lastWriteOk: null,
    onSighup: null,
    onSigterm: null,
  };

  await startRuntime(state, options);

  const controller: RunRegistryController = {
    async reload(): Promise<void> {
      if (state.stopped) return;
      await startRuntime(state, options);
    },
    async stop(): Promise<void> {
      if (state.stopped) return;
      state.stopped = true;
      state.tailer?.stop();
      state.writer?.stopSyncWorker();
      if (state.onSighup) process.removeListener('SIGHUP', state.onSighup);
      if (state.onSigterm) process.removeListener('SIGTERM', state.onSigterm);
    },
    status() {
      return {
        walPending: countWalPending(state.writer),
        lastWriteOk: state.lastWriteOk,
      };
    },
  };

  state.onSighup = () => {
    void controller.reload();
  };
  state.onSigterm = () => {
    void controller.stop();
  };
  process.on('SIGHUP', state.onSighup);
  process.on('SIGTERM', state.onSigterm);

  return controller;
}
