import type { RunRecord } from './contracts.js';

export const RUN_INHERIT_FIELDS = ['project', 'cwd', 'scope', 'agent', 'home_group_id', 'entry_form'] as const;

export type RunInheritField = typeof RUN_INHERIT_FIELDS[number];
export type InheritableRunLike = Pick<RunRecord, RunInheritField>;
export type RunInheritanceSnapshot = {
  [Key in RunInheritField]: InheritableRunLike[Key];
};

export function buildRunInheritanceSnapshot(source: InheritableRunLike): RunInheritanceSnapshot {
  return {
    project: source.project,
    cwd: source.cwd,
    scope: source.scope,
    agent: source.agent,
    home_group_id: source.home_group_id,
    entry_form: source.entry_form,
  };
}
