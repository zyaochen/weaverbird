import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProgressCollector } from '../../../../packages/core/src/run-observability/progress-collector.js';
import type { ProgressStore } from '../../../../packages/core/src/run-observability/progress-store.js';
import type { CardRefresher } from '../../../../packages/core/src/run-observability/card-refresher.js';
import type { FinalizerClient } from '../../../../packages/core/src/run-observability/finalizer.js';
import { finalizeRun } from '../../../../packages/core/src/run-observability/finalizer.js';
import { detectExitError } from '../../../../packages/core/src/run-observability/exit-code-detector.js';
import { pushAlert } from '../../../../packages/core/src/run-observability/alert-pusher.js';

export function wireRunObservability(
  runDir: string,
  deps: {
    collector: ProgressCollector;
    store: ProgressStore;
    /** 不传则不刷进度卡 (运行卡已由调用方渲染时). */
    refresher?: CardRefresher;
    finalizerClient: FinalizerClient;
    dataDir: string;
    alertContext: Parameters<typeof pushAlert>[1];
  },
): {
  onStdout(chunk: string): void;
  onStderr(chunk: string): void;
  onExit(input: { status: 'succeeded' | 'failed' | 'cancelled'; cancelled: boolean; elapsedS: number; exitMeta?: { exit_code?: number | null; signal?: string | null } }): Promise<void>;
} {
  const refreshLatest = async () => {
    if (!deps.refresher) return;
    const entry = deps.store.readEntry();
    if (!entry) return;
    const lines = readFileSync(deps.store.progressPath, 'utf8').trim().split('\n').filter(Boolean);
    const latest = lines.length > 0 ? JSON.parse(lines.at(-1)!).text as string : null;
    await deps.refresher.refresh(entry, latest);
  };

  return {
    onStdout(chunk: string) {
      deps.collector.push('stdout', chunk);
      void refreshLatest();
    },
    onStderr(chunk: string) {
      deps.collector.push('stderr', chunk);
      void refreshLatest();
    },
    async onExit(input) {
      deps.collector.flush();
      const entry = deps.store.readEntry();
      if (!entry) return;
      const nowIso = new Date().toISOString();
      const finalizedEntry = {
        ...entry,
        status: input.status,
        updated_at: nowIso,
        finalized: true,
        cancelled: input.cancelled,
      };
      const lines = readFileSync(join(runDir, 'progress.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).text as string);
      const alert = detectExitError({
        runId: entry.run_id,
        sessionId: entry.session_id,
        status: input.status,
        cancelled: input.cancelled,
        elapsedS: input.elapsedS,
        exitMeta: input.exitMeta,
      });
      if (alert) {
        await pushAlert(alert, deps.alertContext);
      }
      await finalizeRun(finalizedEntry, lines, {
        client: deps.finalizerClient,
        dataDir: deps.dataDir,
        nowIso,
        onFinalized: () => {
          deps.store.saveEntry(finalizedEntry);
        },
      });
    },
  };
}
