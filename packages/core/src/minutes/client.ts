import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runDir } from '../paths.js';
import { appendNdjsonLine } from '../util/ndjson-rotation.js';
import { MinutesContentSchema, MinutesFetchRequestSchema, type MinutesClient, type MinutesContent, type MinutesFetchRequest } from './contracts.js';

function minutesDir(dataDir: string): string {
  return join(dataDir, 'minutes');
}

export function minutesMockFetchLedgerPath(dataDir: string): string {
  return join(minutesDir(dataDir), 'mock-fetch.ndjson');
}

export function runMinutesStatePath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'minutes-context.json');
}

export function runMinutesArtifactDir(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'minutes');
}

export function createInlineMinutesClient(
  handler: (request: MinutesFetchRequest) => Promise<MinutesContent>,
): MinutesClient {
  return {
    async fetchMinutes(request): Promise<MinutesContent> {
      return MinutesContentSchema.parse(await handler(MinutesFetchRequestSchema.parse(request)));
    },
  };
}

export function createMockMinutesClient(
  dataDir: string,
  fixtures: Record<string, MinutesContent>,
): MinutesClient {
  const ledgerPath = minutesMockFetchLedgerPath(dataDir);
  return {
    async fetchMinutes(request): Promise<MinutesContent> {
      const parsed = MinutesFetchRequestSchema.parse(request);
      mkdirSync(dirname(ledgerPath), { recursive: true });
      appendNdjsonLine(ledgerPath, JSON.stringify(parsed));
      const fixture = fixtures[parsed.minute_id];
      if (!fixture) {
        throw new Error(`mock minutes fixture not found: ${parsed.minute_id}`);
      }
      return MinutesContentSchema.parse(fixture);
    },
  };
}

export function createGuardedMinutesClient(): MinutesClient {
  return {
    async fetchMinutes(): Promise<MinutesContent> {
      throw new Error('minutes fetch requires explicit auth and real-device authorization');
    },
  };
}
