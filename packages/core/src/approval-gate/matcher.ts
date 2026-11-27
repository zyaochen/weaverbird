import {
  APPROVAL_GATE_ANCHORS,
  APPROVAL_GATE_APPROVER_POLICY,
  APPROVAL_GATE_TIMEOUT_MS,
  type ApprovalGateMatch,
} from './contracts.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function shellCommand(input: unknown): string | undefined {
  return normalizeWhitespace(readString(asRecord(input)?.['command']) ?? '');
}

function filePath(input: unknown): string | undefined {
  return normalizeWhitespace(readString(asRecord(input)?.['file_path']) ?? '');
}

function lower(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

function looksLikeMainBranchWrite(command: string): boolean {
  const normalized = lower(command);
  if (!normalized.startsWith('git push')) return false;
  return [
    /\bmain\b/,
    /head:main\b/,
    /refs\/heads\/main\b/,
    /origin\/main\b/,
  ].some((pattern) => pattern.test(normalized));
}

function looksLikeEnvVarChange(toolName: string, input: unknown): boolean {
  if (toolName === 'Write' || toolName === 'Edit') {
    const path = lower(filePath(input));
    return /(^|\/)\.env(\.|$)|\.env$/.test(path);
  }
  if (toolName !== 'Bash') return false;
  const command = lower(shellCommand(input));
  return /(^| )(export|unset) [a-z_][a-z0-9_]*=?/i.test(command)
    || /(^| )env [a-z_][a-z0-9_]*=/i.test(command);
}

function looksLikeDependencyManifest(path: string): boolean {
  return /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|pyproject\.toml|requirements(\.[a-z0-9_-]+)?\.txt)$/i.test(path);
}

function looksLikeExternalDepUpgrade(toolName: string, input: unknown): boolean {
  if (toolName === 'Write' || toolName === 'Edit') {
    return looksLikeDependencyManifest(lower(filePath(input)));
  }
  if (toolName !== 'Bash') return false;
  const command = lower(shellCommand(input));
  return /(npm|pnpm|yarn|uv|pip) (install|add|update|upgrade)\b/.test(command);
}

function summarize(toolName: string, input: unknown): string {
  const record = asRecord(input) ?? {};
  const command = readString(record['command']);
  if (command) return normalizeWhitespace(command).slice(0, 200);
  const path = readString(record['file_path']) ?? readString(record['pattern']);
  if (path) return normalizeWhitespace(path).slice(0, 200);
  return JSON.stringify(input).slice(0, 200);
}

function resource(toolName: string, input: unknown): string {
  const record = asRecord(input) ?? {};
  const command = readString(record['command']);
  if (command) return normalizeWhitespace(command).slice(0, 500);
  const path = readString(record['file_path']) ?? readString(record['pattern']);
  if (path) return normalizeWhitespace(path).slice(0, 500);
  return `${toolName}:${JSON.stringify(input).slice(0, 400)}`;
}

export function matchApprovalGate(toolName: string, input: unknown): ApprovalGateMatch | null {
  if (toolName === 'Bash') {
    const command = shellCommand(input);
    if (command && looksLikeMainBranchWrite(command)) {
      return {
        anchor: APPROVAL_GATE_ANCHORS.WRITE_TO_MAIN_BRANCH,
        approverPolicy: APPROVAL_GATE_APPROVER_POLICY.OWNER_AND_CODE_OWNER,
        timeoutMs: APPROVAL_GATE_TIMEOUT_MS.writeToMainBranch,
        toolName,
        toolInput: input,
        summary: summarize(toolName, input),
        resource: resource(toolName, input),
      };
    }
  }

  if (looksLikeEnvVarChange(toolName, input)) {
    return {
      anchor: APPROVAL_GATE_ANCHORS.ENV_VAR_CHANGE,
      approverPolicy: APPROVAL_GATE_APPROVER_POLICY.OWNER,
      timeoutMs: APPROVAL_GATE_TIMEOUT_MS.envVarChange,
      toolName,
      toolInput: input,
      summary: summarize(toolName, input),
      resource: resource(toolName, input),
    };
  }

  if (looksLikeExternalDepUpgrade(toolName, input)) {
    return {
      anchor: APPROVAL_GATE_ANCHORS.EXTERNAL_DEP_UPGRADE,
      approverPolicy: APPROVAL_GATE_APPROVER_POLICY.OWNER,
      timeoutMs: APPROVAL_GATE_TIMEOUT_MS.externalDepUpgrade,
      toolName,
      toolInput: input,
      summary: summarize(toolName, input),
      resource: resource(toolName, input),
    };
  }

  return null;
}
