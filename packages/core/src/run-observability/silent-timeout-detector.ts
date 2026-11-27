import { type ObservabilityStoreEntry } from './contracts.js';

export function shouldAlertSilentTimeout(
  entry: ObservabilityStoreEntry,
  options: {
    nowIso: string;
    silentTimeoutS: number;
    storeExists: boolean;
  },
): boolean {
  if (entry.alerted) return false;
  if (entry.cancelled) return false;
  if (entry.finalized) return false;

  const baseline = entry.last_stdout_at ?? (options.storeExists ? entry.updated_at : entry.created_at);
  const elapsedMs = Date.parse(options.nowIso) - Date.parse(baseline);
  return elapsedMs > options.silentTimeoutS * 1000;
}
