import type { ReverseAtCancelTarget } from './reverse-at-im-handler.js';

export type SessionShortIdTargetLike = {
  agentId: string;
  runId?: string;
  sessionShortId?: string;
};

export function resolveReverseAtCancelTargetFromSession(
  session: SessionShortIdTargetLike | undefined,
): ReverseAtCancelTarget | null {
  if (!session?.runId || !session.sessionShortId) return null;
  return {
    runId: session.runId,
    shortId: session.sessionShortId,
    label: `${session.agentId} · ${session.sessionShortId}`,
  };
}
