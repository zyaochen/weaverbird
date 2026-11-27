import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { periodicOccurrenceLedgerPath, periodicTasksStatePath, runPeriodicTaskStatePath } from '../paths.js';
import { appendNdjsonLine } from '../util/ndjson-rotation.js';
import {
  PeriodicOccurrenceLedgerRecordSchema,
  PeriodicStateEntrySchema,
  PeriodicStateSchema,
  PeriodicTaskRunSidecarSchema,
  type PeriodicOccurrenceLedgerRecord,
  type PeriodicState,
  type PeriodicStateEntry,
  type PeriodicTaskRunSidecar,
} from './contracts.js';

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

export function readPeriodicState(dataDir: string): PeriodicState {
  const path = periodicTasksStatePath(dataDir);
  if (!existsSync(path)) return PeriodicStateSchema.parse({ version: 1, tasks: {} });
  return PeriodicStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function writePeriodicState(dataDir: string, state: PeriodicState): void {
  atomicWrite(periodicTasksStatePath(dataDir), JSON.stringify(state, null, 2));
}

export function readPeriodicStateEntry(state: PeriodicState, taskId: string): PeriodicStateEntry {
  return PeriodicStateEntrySchema.parse(state.tasks[taskId] ?? {});
}

export function writePeriodicOccurrenceLedger(dataDir: string, record: PeriodicOccurrenceLedgerRecord): void {
  appendNdjsonLine(periodicOccurrenceLedgerPath(dataDir), JSON.stringify(PeriodicOccurrenceLedgerRecordSchema.parse(record)));
}

export function writePeriodicRunSidecar(dataDir: string, runId: string, botId: string, sidecar: PeriodicTaskRunSidecar): void {
  atomicWrite(runPeriodicTaskStatePath(dataDir, runId, botId), JSON.stringify(PeriodicTaskRunSidecarSchema.parse(sidecar), null, 2));
}
