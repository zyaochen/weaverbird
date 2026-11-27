import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { calendarMockTriggersPath } from '../paths.js';
import { CalendarBlockResultSchema, type CalendarBlockRequest, type CalendarBlockResult, type CalendarTransport, type CalendarTriggerRecord } from './contracts.js';

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function readMockBlocks(path: string): Record<string, { calendar_block_id: string; open: boolean }> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, { calendar_block_id: string; open: boolean }>;
  } catch {
    return {};
  }
}

export function createMockCalendarTransport(dataDir: string): CalendarTransport {
  const statePath = calendarMockTriggersPath(dataDir).replace('mock-triggers.json', 'mock-blocks.json');
  return {
    async openBlock(input: CalendarBlockRequest): Promise<CalendarBlockResult> {
      const blocks = readMockBlocks(statePath);
      const existing = blocks[input.run_id];
      if (existing?.open) {
        return CalendarBlockResultSchema.parse({ calendar_block_id: existing.calendar_block_id });
      }
      const calendar_block_id = `cal_${input.run_id}`;
      blocks[input.run_id] = { calendar_block_id, open: true };
      atomicWrite(statePath, JSON.stringify(blocks, null, 2));
      return CalendarBlockResultSchema.parse({ calendar_block_id });
    },
    async closeBlock(input: { run_id: string; revision: number; calendar_block_id: string }): Promise<void> {
      const blocks = readMockBlocks(statePath);
      const existing = blocks[input.run_id];
      if (existing) {
        blocks[input.run_id] = { ...existing, open: false };
        atomicWrite(statePath, JSON.stringify(blocks, null, 2));
      }
    },
  };
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function createGuardedCliCalendarTransport(): CalendarTransport {
  return {
    async openBlock(): Promise<CalendarBlockResult> {
      throw new Error('calendar cli transport requires explicit real-device authorization');
    },
    async closeBlock(): Promise<void> {
      throw new Error('calendar cli transport requires explicit real-device authorization');
    },
  };
}
