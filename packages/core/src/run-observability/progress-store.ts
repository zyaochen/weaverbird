import * as fs from 'node:fs';
import { join } from 'node:path';
import { runDir } from '../paths.js';
import {
  ObservabilityStoreEntrySchema,
  PROGRESS_STORE_MAX_BYTES,
  RUN_OBSERVABILITY_ERROR_CODES,
  RunObservabilityEventSchema,
  type ObservabilityStoreEntry,
  type RunObservabilityEvent,
} from './contracts.js';

export type ProgressStoreAppendInput = {
  lineIndex: number;
  source: 'stdout' | 'stderr';
  text: string;
  ts: string;
};

export type ProgressStoreAppendResult = {
  ok: boolean;
  wroteLine: boolean;
  storeTruncated: boolean;
};

type ProgressStoreFs = Pick<typeof fs, 'mkdirSync' | 'existsSync' | 'statSync' | 'appendFileSync' | 'readFileSync' | 'writeFileSync'>;

export class ProgressStore {
  readonly runDir: string;
  readonly progressPath: string;
  readonly metaPath: string;
  private readonly fsImpl: ProgressStoreFs;

  constructor(private readonly options: {
    dataDir: string;
    botId: string;
    runId: string;
    sessionId: string;
    originMessageId?: string | null;
    cardMessageId?: string | null;
    homeGroupId?: string | null;
    nowFn?: () => string;
    maxBytes?: number;
    fsImpl?: ProgressStoreFs;
  }) {
    this.fsImpl = options.fsImpl ?? fs;
    this.runDir = runDir(options.dataDir, options.runId, options.botId);
    this.progressPath = join(this.runDir, 'progress.ndjson');
    this.metaPath = join(this.runDir, 'meta.json');
    this.fsImpl.mkdirSync(this.runDir, { recursive: true });
  }

  append(input: ProgressStoreAppendInput): ProgressStoreAppendResult {
    const entry = this.readEntry() ?? this.defaultEntry(input.ts);
    entry.step_index = input.lineIndex;
    entry.updated_at = input.ts;
    if (input.source === 'stdout') entry.last_stdout_at = input.ts;

    if (entry.store_truncated) {
      this.writeEntry(entry);
      return { ok: true, wroteLine: false, storeTruncated: true };
    }

    const event = this.normalizeEvent(input);
    const line = `${JSON.stringify(event)}\n`;
    const maxBytes = this.options.maxBytes ?? PROGRESS_STORE_MAX_BYTES;
    const currentSize = this.fsImpl.existsSync(this.progressPath) ? this.fsImpl.statSync(this.progressPath).size : 0;
    if (currentSize + Buffer.byteLength(line) > maxBytes) {
      entry.store_truncated = true;
      this.writeEntry(entry);
      return { ok: true, wroteLine: false, storeTruncated: true };
    }

    const wroteLine = this.writeProgressLine(line);
    this.writeEntry(entry);
    return { ok: wroteLine, wroteLine, storeTruncated: entry.store_truncated };
  }

  readEntry(): ObservabilityStoreEntry | null {
    if (!this.fsImpl.existsSync(this.metaPath)) return null;
    const raw = this.fsImpl.readFileSync(this.metaPath, 'utf8');
    return ObservabilityStoreEntrySchema.parse(JSON.parse(raw));
  }

  readOrInitEntry(ts = this.now()): ObservabilityStoreEntry {
    return this.readEntry() ?? this.defaultEntry(ts);
  }

  saveEntry(entry: ObservabilityStoreEntry): void {
    this.writeEntry(entry);
  }

  private defaultEntry(ts: string): ObservabilityStoreEntry {
    return ObservabilityStoreEntrySchema.parse({
      run_id: this.options.runId,
      session_id: this.options.sessionId,
      status: 'active',
      updated_at: ts,
      last_stdout_at: null,
      origin_message_id: this.options.originMessageId ?? null,
      card_message_id: this.options.cardMessageId ?? null,
      home_group_id: this.options.homeGroupId ?? null,
      created_at: ts,
      alert_reason: null,
    });
  }

  private now(): string {
    return this.options.nowFn?.() ?? new Date().toISOString();
  }

  private normalizeEvent(input: ProgressStoreAppendInput): RunObservabilityEvent {
    const text = input.text.length > 65_536 ? input.text.slice(0, 65_536) : input.text;
    return RunObservabilityEventSchema.parse({
      run_id: this.options.runId,
      ts: input.ts,
      line_index: input.lineIndex,
      text,
      source: input.source,
      truncated: text !== input.text,
    });
  }

  private writeProgressLine(line: string): boolean {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.fsImpl.appendFileSync(this.progressPath, line, 'utf8');
        return true;
      } catch {
        if (attempt === 1) return false;
      }
    }
    return false;
  }

  private writeEntry(entry: ObservabilityStoreEntry): void {
    const parsed = ObservabilityStoreEntrySchema.parse(entry);
    this.fsImpl.writeFileSync(this.metaPath, JSON.stringify(parsed, null, 2));
  }
}

export { RUN_OBSERVABILITY_ERROR_CODES };
