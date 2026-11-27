#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startAuditPipe } from './index.js';

export function resolveAuditPipeCommand(argv: string[]): { once: boolean; intervalMs?: number } {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      once: { type: 'boolean', default: false },
      interval: { type: 'string' },
    },
  });
  const intervalRaw = parsed.values.interval;
  return { once: parsed.values.once, intervalMs: intervalRaw ? Number.parseInt(intervalRaw, 10) : undefined };
}

async function main(): Promise<void> {
  const command = resolveAuditPipeCommand(process.argv.slice(2));
  const controller = await startAuditPipe();
  if (command.once) {
    const waitMs = command.intervalMs && command.intervalMs > 0 ? Math.min(command.intervalMs, 1_000) : 1_000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    await controller.stop();
    return;
  }
  await new Promise<void>((resolve) => {
    const shutdown = () => { void controller.stop().finally(resolve); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

const isEntry = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isEntry) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
