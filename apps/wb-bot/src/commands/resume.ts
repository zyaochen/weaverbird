import { randomUUID } from 'node:crypto';
import { createRunRegistryWriter, RUN_REGISTRY_ERROR_CODES, RunRegistryError, type RunRecord } from '../../../../packages/core/src/run-registry/index.js';
import type { CommandContext } from './router.js';

const INHERIT_FIELDS = ['project', 'cwd', 'scope', 'agent', 'home_group_id', 'entry_form'] as const;

type InheritField = typeof INHERIT_FIELDS[number];
export type InheritResult = {
  fromRunId: string;
  newRunId: string;
  inherited: Record<InheritField, string | null>;
  excluded: Pick<RunRecord, 'risk_level' | 'cost_tokens' | 'cost_minutes' | 'produced_doc_urls' | 'commit_shas'>;
};

function makeNewRunId(): string {
  return randomUUID();
}

export function buildInheritedRun(fromRun: RunRecord, newRunId = makeNewRunId()): InheritResult {
  return {
    fromRunId: fromRun.run_id,
    newRunId,
    inherited: {
      project: fromRun.project,
      cwd: fromRun.cwd,
      scope: fromRun.scope,
      agent: fromRun.agent,
      home_group_id: fromRun.home_group_id,
      entry_form: fromRun.entry_form,
    },
    excluded: {
      risk_level: 'unknown',
      cost_tokens: null,
      cost_minutes: null,
      produced_doc_urls: [],
      commit_shas: [],
    },
  };
}

export async function handleResume(args: string[], ctx: CommandContext): Promise<string> {
  if (args[0] !== 'resume' || args[1] !== '--inherit' || !args[2]) {
    return 'Usage: /wb resume --inherit <run_id>';
  }
  const runId = args[2];
  const writer = createRunRegistryWriter();
  const fromRun = await writer.findByRunId(runId);
  if (!fromRun) {
    throw new RunRegistryError(RUN_REGISTRY_ERROR_CODES.E_INHERIT_NOT_FOUND, `run ${runId} not found in registry`);
  }
  const inherited = buildInheritedRun(fromRun);
  ctx.store.setCurrentAgent(ctx.botId, ctx.userOpenId, ctx.threadId, inherited.inherited.agent ?? 'claude-code');
  ctx.store.setCurrentCwd(ctx.botId, ctx.userOpenId, ctx.threadId, inherited.inherited.cwd);
  return [
    `♻️ Inherited run ${runId}`,
    `new_run_id=${inherited.newRunId}`,
    `agent=${inherited.inherited.agent}`,
    `cwd=${inherited.inherited.cwd}`,
    `scope=${inherited.inherited.scope}`,
  ].join('\n');
}
