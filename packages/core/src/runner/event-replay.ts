import { existsSync, readFileSync } from 'node:fs';
import type { AgentEvent } from '../agent/types.js';

export const SUPPORTED_SCHEMA_VERSION = 1;

export type ReplayResult = {
  events: AgentEvent[];
  latestContinuationToken?: string;
  errors: string[];
  skipped: boolean;
};

function isAgentEventType(type: unknown): type is AgentEvent['type'] {
  return typeof type === 'string' && [
    'system', 'text', 'thinking', 'tool_use', 'tool_progress',
    'tool_result', 'usage', 'consent_required', 'done', 'error',
  ].includes(type);
}

function parseEventLine(line: string): { event: AgentEvent | null; schemaVersion: number; error?: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { event: null, schemaVersion: 0, error: `JSON parse failed: ${line.slice(0, 100)}` };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { event: null, schemaVersion: 0, error: 'parsed value is not an object' };
  }

  const schemaVersion = typeof parsed['schemaVersion'] === 'number' ? parsed['schemaVersion'] : 0;

  if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    return { event: null, schemaVersion, error: `schemaVersion ${schemaVersion} > supported ${SUPPORTED_SCHEMA_VERSION}` };
  }

  const type = parsed['type'];
  if (!isAgentEventType(type)) {
    if (type === 'heartbeat') {
      return { event: null, schemaVersion, error: undefined };
    }
    return { event: null, schemaVersion, error: undefined };
  }

  return { event: parsed as unknown as AgentEvent, schemaVersion, error: undefined };
}

export function replayEventsFromNdjson(ndjsonPath: string): ReplayResult {
  if (!existsSync(ndjsonPath)) {
    return { events: [], errors: [], skipped: false };
  }

  const content = readFileSync(ndjsonPath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);

  const events: AgentEvent[] = [];
  const errors: string[] = [];
  let latestContinuationToken: string | undefined;
  let skipped = false;

  for (const line of lines) {
    const { event, schemaVersion, error } = parseEventLine(line);

    if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
      errors.push(error ?? `unsupported schemaVersion ${schemaVersion}`);
      skipped = true;
      return { events: [], latestContinuationToken: undefined, errors, skipped };
    }

    if (error) {
      errors.push(error);
      continue;
    }

    if (!event) continue;

    events.push(event);

    if (event.type === 'system' && event.continuationToken) {
      latestContinuationToken = event.continuationToken;
    }
    if (event.type === 'done' && event.continuationToken) {
      latestContinuationToken = event.continuationToken;
    }
  }

  return { events, latestContinuationToken, errors, skipped };
}
