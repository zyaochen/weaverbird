import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  auditMirrorPath,
  auditRejectedPath,
  auditWalDir,
  configFile,
  runAuditOffsetPath,
  runDir as resolveRunDir,
  runsRootDir,
} from '../paths.js';
import { appendNdjsonLine, readNdjsonSegments } from '../util/ndjson-rotation.js';
import { loadAuditPipeConfig, resolveAuditDataDir } from './config.js';
import { DEFAULT_RETRY_POLICY, type AuditPipeConfig, type AuditPipeController, type AuditRecord, type RetryPolicy, type RunSpec } from './contracts.js';
import { createMirrorSink } from './mirror-sink.js';
import { normalize, hydrateNormalizer, resetNormalizerState } from './normalizer.js';
import { parseEventLine } from './parser.js';
import { createTailer, type Tailer } from './tailer.js';
import { createWal, type Wal } from './wal.js';
import { createBitableSink, type BitableClientLike, type BitableSink } from './bitable-sink.js';

export type StartAuditPipeOptions = {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  _bitableClient?: BitableClientLike;
  _retryOverride?: RetryPolicy;
  _scanIntervalMs?: number;
  _drainIntervalMs?: number;
};

type TailerEntry = { timer: NodeJS.Timeout; tailer: Tailer; runDir: string; draining: boolean };

type RuntimeState = {
  configPath: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  config: AuditPipeConfig | null;
  wal: Wal | null;
  bitableSink: BitableSink | null;
  tailers: Map<string, TailerEntry>;
  scanTimer: NodeJS.Timeout | null;
  flushTimer: NodeJS.Timeout | null;
  lastBitableOk: string | null;
  stopped: boolean;
  scanning: boolean;
  flushChain: Promise<void>;
  onSighup: (() => void) | null;
  onSigterm: (() => void) | null;
  bitableClient?: BitableClientLike;
  retryOverride?: RetryPolicy;
  scanIntervalMs: number;
  drainIntervalMs: number;
};

function readRunSpec(runDir: string): RunSpec | null {
  const specPath = join(runDir, 'spec.json');
  if (!existsSync(specPath)) return null;
  try {
    return JSON.parse(readFileSync(specPath, 'utf8')) as RunSpec;
  } catch {
    return null;
  }
}

function listRunDirs(dataDir: string): string[] {
  const runsRoot = runsRootDir(dataDir);
  if (!existsSync(runsRoot)) return [];
  const runDirs: string[] = [];
  for (const botEntry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!botEntry.isDirectory()) continue;
    const botDir = join(runsRoot, botEntry.name);
    for (const runEntry of readdirSync(botDir, { withFileTypes: true })) {
      if (runEntry.isDirectory()) runDirs.push(resolveRunDir(dataDir, runEntry.name, botEntry.name));
    }
  }
  return runDirs.sort();
}

function readAuditMirrorRecords(dataDir: string): AuditRecord[] {
  const path = auditMirrorPath(dataDir);
  const records: AuditRecord[] = [];
  for (const line of readNdjsonSegments(path)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed['status'] !== 'rejected' && typeof parsed['run_id'] === 'string' && typeof parsed['raw_tool_use_id'] === 'string' && typeof parsed['revision'] === 'number' && typeof parsed['audit_record_id'] === 'string') {
        records.push(parsed as unknown as AuditRecord);
      }
    } catch {
      continue;
    }
  }
  return records;
}

function appendRejected(dataDir: string, line: string): void {
  appendNdjsonLine(auditRejectedPath(dataDir), line);
}

function countWalPending(dataDir: string): number {
  const walDir = auditWalDir(dataDir);
  if (!existsSync(walDir)) return 0;
  return readdirSync(walDir).filter((file) => file.endsWith('.jsonl')).length;
}

function queueFlush(state: RuntimeState): Promise<void> {
  if (!state.bitableSink) return Promise.resolve();
  state.flushChain = state.flushChain.then(async () => {
    const result = await state.bitableSink?.flush();
    if (result?.ok) state.lastBitableOk = new Date().toISOString();
  }).catch(() => undefined);
  return state.flushChain;
}

function clearTailers(state: RuntimeState): void {
  for (const entry of state.tailers.values()) clearInterval(entry.timer);
  state.tailers.clear();
}

function clearRuntimeTimers(state: RuntimeState): void {
  if (state.scanTimer) {
    clearInterval(state.scanTimer);
    state.scanTimer = null;
  }
  if (state.flushTimer) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }
}

async function drainRun(state: RuntimeState, runDir: string, tailer: Tailer): Promise<void> {
  const spec = readRunSpec(runDir);
  for await (const line of tailer.tick()) {
    const event = parseEventLine(line);
    if (!event) continue;
    const result = normalize(event, spec, new Date().toISOString(), line);
    if (result.kind === 'rejected') {
      if (state.config) createMirrorSink({ dataDir: state.dataDir }).write(result.record);
      appendRejected(state.dataDir, JSON.stringify(result.record));
      continue;
    }
    if (state.config) createMirrorSink({ dataDir: state.dataDir }).write(result.record);
    state.wal?.append(result.record);
    await queueFlush(state);
  }
}

function attachRun(state: RuntimeState, runDir: string): void {
  if (state.tailers.has(runDir) || !existsSync(join(runDir, 'spec.json'))) return;
  const runId = basename(runDir);
  const botId = basename(dirname(runDir));
  const tailer = createTailer({
    eventsPath: join(runDir, 'events.ndjson'),
    offsetPath: runAuditOffsetPath(state.dataDir, runId, botId),
  });
  const entry: TailerEntry = {
    runDir,
    tailer,
    timer: setInterval(() => undefined, state.drainIntervalMs),
    draining: false,
  };
  const tick = () => {
    if (state.stopped || entry.draining) return;
    entry.draining = true;
    void drainRun(state, runDir, tailer).finally(() => {
      entry.draining = false;
    });
  };
  clearInterval(entry.timer);
  entry.timer = setInterval(tick, state.drainIntervalMs);
  state.tailers.set(runDir, entry);
  tick();
}

function scanAndAttachMissingRuns(state: RuntimeState): void {
  if (state.stopped || state.scanning || !state.config?.audit.enabled) return;
  state.scanning = true;
  try {
    for (const runDir of listRunDirs(state.dataDir)) {
      attachRun(state, runDir);
    }
  } finally {
    state.scanning = false;
  }
}

function buildBitableSink(state: RuntimeState, config: AuditPipeConfig): BitableSink | null {
  if (!config.audit.enabled) return null;
  return createBitableSink({
    dataDir: state.dataDir,
    baseId: config.audit.bitable_base_id,
    tableId: config.audit.bitable_table_id,
    appId: config.audit.app_id,
    appSecret: config.audit.app_secret,
    larkDomain: config.audit.lark_domain,
    retry: state.retryOverride ?? DEFAULT_RETRY_POLICY,
    wal: state.wal ?? createWal({ dataDir: state.dataDir }),
    _client: state.bitableClient,
  });
}

async function startRuntime(state: RuntimeState): Promise<void> {
  const config = loadAuditPipeConfig({ configPath: state.configPath, env: state.env });
  state.config = config;
  clearTailers(state);
  clearRuntimeTimers(state);
  state.scanning = false;

  if (!config.audit.enabled) {
    state.wal = null;
    state.bitableSink = null;
    return;
  }

  mkdirSync(state.dataDir, { recursive: true });
  resetNormalizerState();
  hydrateNormalizer(readAuditMirrorRecords(state.dataDir));
  state.wal = createWal({ dataDir: state.dataDir });
  state.bitableSink = buildBitableSink(state, config);

  scanAndAttachMissingRuns(state);
  state.scanTimer = setInterval(() => {
    scanAndAttachMissingRuns(state);
  }, state.scanIntervalMs);
  state.flushTimer = setInterval(() => {
    void queueFlush(state);
  }, 60_000);
  await queueFlush(state);
}

export async function startAuditPipe(options: StartAuditPipeOptions = {}): Promise<AuditPipeController> {
  const env = options.env ?? process.env;
  const dataDir = resolveAuditDataDir(env);
  const state: RuntimeState = {
    configPath: options.configPath ?? resolve(configFile(dataDir, 'audit-pipe')),
    dataDir,
    env,
    config: null,
    wal: null,
    bitableSink: null,
    tailers: new Map(),
    scanTimer: null,
    flushTimer: null,
    lastBitableOk: null,
    stopped: false,
    scanning: false,
    flushChain: Promise.resolve(),
    onSighup: null,
    onSigterm: null,
    bitableClient: options._bitableClient,
    retryOverride: options._retryOverride,
    scanIntervalMs: options._scanIntervalMs ?? 500,
    drainIntervalMs: options._drainIntervalMs ?? 200,
  };

  await startRuntime(state);

  const controller: AuditPipeController = {
    async reload(): Promise<void> {
      if (state.stopped) return;
      await startRuntime(state);
    },
    async stop(): Promise<void> {
      if (state.stopped) return;
      state.stopped = true;
      clearTailers(state);
      clearRuntimeTimers(state);
      if (state.onSighup) process.removeListener('SIGHUP', state.onSighup);
      if (state.onSigterm) process.removeListener('SIGTERM', state.onSigterm);
      await Promise.race([state.flushChain, new Promise<void>((resolve) => setTimeout(resolve, 30_000))]);
    },
    status() {
      return {
        tailers: state.tailers.size,
        walPending: countWalPending(state.dataDir),
        lastBitableOk: state.lastBitableOk,
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
