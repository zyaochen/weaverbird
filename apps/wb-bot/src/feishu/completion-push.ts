const DEFAULT_THRESHOLD_MS = 300_000;

export interface PushDecisionInput {
  durationMs: number;
  thresholdMs: number;
  hasFollow: boolean;
}

export function shouldPushOnDone(input: PushDecisionInput): boolean {
  return input.durationMs >= input.thresholdMs || input.hasFollow;
}

export function parsePushThresholdMs(envValue: string | undefined, defaultMs: number = DEFAULT_THRESHOLD_MS): number {
  if (envValue === undefined) return defaultMs;
  const parsed = Number.parseInt(envValue, 10);
  if (Number.isNaN(parsed) || parsed < 0) return defaultMs;
  return parsed;
}

export function formatDurationHuman(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (totalMinutes < 60) {
    return secs > 0 ? `${totalMinutes}m${secs}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
}

export function formatCompletionMessage(displayName: string, cwd: string, durationMs: number): string {
  const home = process.env['HOME'] ?? '';
  const shortCwd = (home && cwd.startsWith(home)) ? `~${cwd.slice(home.length)}` : cwd;
  return `✅ ${displayName} · ${shortCwd} · ${formatDurationHuman(durationMs)} · 任务完成`;
}
