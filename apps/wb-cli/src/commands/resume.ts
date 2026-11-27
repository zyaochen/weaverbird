import { randomUUID } from 'node:crypto';
import { createRunRegistryWriter, RUN_REGISTRY_ERROR_CODES, type RunRecord } from '@weaverbird/core/run-registry';

export const CLI_INHERIT_FIELDS = ['project', 'cwd', 'scope', 'agent', 'home_group_id', 'entry_form'] as const;
export type CliInheritField = typeof CLI_INHERIT_FIELDS[number];

export type CliInheritResult = {
  fromRunId: string;
  newRunId: string;
  inherited: Record<CliInheritField, string | null>;
};

export function buildCliInheritedRun(fromRun: RunRecord, newRunId = randomUUID()): CliInheritResult {
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
  };
}

export async function resumeInheritCommand(argv: string[]): Promise<number> {
  const inheritIdx = argv.indexOf('--inherit');
  const runId = inheritIdx >= 0 ? argv[inheritIdx + 1] : undefined;
  if (inheritIdx < 0 || !runId) {
    process.stderr.write('Usage: wb-cli resume --inherit <run_id>\n');
    return 1;
  }
  const writer = createRunRegistryWriter();
  let fromRun: RunRecord | null;
  try {
    fromRun = await writer.findByRunId(runId);
  } catch (error) {
    process.stderr.write(`resume --inherit lookup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (!fromRun) {
    process.stderr.write(`${RUN_REGISTRY_ERROR_CODES.E_INHERIT_NOT_FOUND}: run ${runId} not found in registry\n`);
    return 2;
  }
  const inherited = buildCliInheritedRun(fromRun);
  process.stdout.write([
    `♻️ Inherited run ${runId}`,
    `new_run_id=${inherited.newRunId}`,
    `agent=${inherited.inherited.agent}`,
    `cwd=${inherited.inherited.cwd}`,
    `scope=${inherited.inherited.scope}`,
    `project=${inherited.inherited.project ?? '-'}`,
    `home_group_id=${inherited.inherited.home_group_id ?? '-'}`,
    `entry_form=${inherited.inherited.entry_form}`,
  ].join('\n') + '\n');
  return 0;
}
