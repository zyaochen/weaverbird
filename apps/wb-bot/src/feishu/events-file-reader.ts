import { existsSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { AgentEvent } from '../../../../packages/core/src/agent/types.js';

export const EVENTS_SUPPORTED_SCHEMA_VERSION = 1;

export function extractLatestContinuationToken(events: Array<Record<string, unknown>>): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if ((ev['type'] === 'done' || ev['type'] === 'system') && typeof ev['continuationToken'] === 'string') {
      return ev['continuationToken'];
    }
  }
  return undefined;
}

export type SchemaCheckResult = { ok: boolean; version: number; message?: string };

export function checkSchemaVersion(specOrHeader: Record<string, unknown> | undefined): SchemaCheckResult {
  if (!specOrHeader || specOrHeader['schemaVersion'] === undefined) {
    return { ok: true, version: 1 };
  }
  const version = typeof specOrHeader['schemaVersion'] === 'number' ? specOrHeader['schemaVersion'] : 1;
  if (version > EVENTS_SUPPORTED_SCHEMA_VERSION) {
    return { ok: false, version, message: `schemaVersion ${version} > supported ${EVENTS_SUPPORTED_SCHEMA_VERSION}` };
  }
  return { ok: true, version };
}

export function parseEventLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function readEventsSync(ndjsonPath: string): Array<Record<string, unknown>> {
  if (!existsSync(ndjsonPath)) return [];
  try {
    const raw = readFileSync(ndjsonPath, 'utf8');
    const lines = raw.split('\n');
    const events: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      const parsed = parseEventLine(line);
      if (parsed) events.push(parsed);
    }
    return events;
  } catch {
    return [];
  }
}

export class EventsFileReader extends EventEmitter {
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly ndjsonPath: string, startOffset = 0) {
    super();
    this.offset = startOffset;
  }

  start(): void {
    this.timer = setInterval(() => this.poll(), 200);
  }

  stop(): void {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private poll(): void {
    if (this.closed) return;
    if (!existsSync(this.ndjsonPath)) return;
    try {
      const { size } = statSync(this.ndjsonPath);
      if (size <= this.offset) return;
      const stream = createReadStream(this.ndjsonPath, { start: this.offset, encoding: 'utf8' });
      const rl = createInterface({ input: stream });
      rl.on('line', (line) => {
        if (this.closed) return;
        try {
          const parsed = JSON.parse(line) as AgentEvent;
          if (typeof parsed === 'object' && parsed !== null && parsed.type) {
            this.emit('event', parsed);
          }
        } catch {
          // skip non-JSON lines
        }
      });
      rl.once('close', () => {
        this.offset = size;
      });
    } catch {
      // file access error, retry next poll
    }
  }

  async *events(): AsyncGenerator<AgentEvent> {
    const queue: AgentEvent[] = [];
    let resolve: (() => void) | null = null;

    const onEvent = (event: AgentEvent) => {
      queue.push(event);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    this.on('event', onEvent);

    try {
      while (!this.closed) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise<void>((r) => { resolve = r; });
        }
      }
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    } finally {
      this.removeListener('event', onEvent);
    }
  }
}
