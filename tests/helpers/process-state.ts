import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function linuxState(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = raw.match(/^State:\s+([A-Z])/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function darwinState(pid: number): string | null {
  const result = spawnSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export function readProcessState(pid: number): string | null {
  if (process.platform === 'linux') return linuxState(pid);
  if (process.platform === 'darwin') return darwinState(pid);
  return null;
}

export async function waitForStoppedState(pid: number, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readProcessState(pid);
    if (state?.startsWith('T')) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
