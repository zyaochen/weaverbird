import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MinutesContentSchema,
  MinutesFetchRequestSchema,
  MinutesRunArtifactSchema,
  MinutesRunStateSchema,
  type MinutesClient,
  type MinutesContent,
  type MinutesFetchRequest,
  type MinutesRunArtifact,
  type MinutesRunState,
} from './contracts.js';
import { runMinutesArtifactDir, runMinutesStatePath } from './client.js';

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function readMinutesState(path: string, request: MinutesFetchRequest, nowIso: string): MinutesRunState {
  if (!existsSync(path)) {
    return MinutesRunStateSchema.parse({
      session_id: request.session_id,
      run_id: request.run_id,
      last_revision: request.revision,
      updated_at: nowIso,
      artifacts: [],
    });
  }
  return MinutesRunStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function writeMinutesState(path: string, state: MinutesRunState): void {
  atomicWrite(path, JSON.stringify(state, null, 2));
}

function sanitizeIdPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function buildAttachId(request: MinutesFetchRequest): string {
  return ['minutes', sanitizeIdPart(request.minute_id), sanitizeIdPart(request.content_kind)].join(':');
}

function buildArtifactPath(dataDir: string, runId: string, attachId: string, botId = 'default'): string {
  return join(runMinutesArtifactDir(dataDir, runId, botId), `${sanitizeIdPart(attachId)}.md`);
}

function buildArtifactBody(request: MinutesFetchRequest, content: MinutesContent): string {
  const header = [
    `# ${content.title}`,
    '',
    `- minute_id: ${request.minute_id}`,
    `- run_id: ${request.run_id}`,
    `- session_id: ${request.session_id}`,
    `- revision: ${request.revision}`,
    `- content_kind: ${request.content_kind}`,
    `- source_url: ${content.source_url ?? 'none'}`,
    '',
  ];
  return `${header.join('\n')}${content.content.trim()}\n`;
}

function mergeMinutesState(state: MinutesRunState, artifact: MinutesRunArtifact, nowIso: string): MinutesRunState {
  const artifacts = state.artifacts.filter((item) => item.attach_id !== artifact.attach_id);
  artifacts.push(artifact);
  artifacts.sort((left, right) => left.attach_id.localeCompare(right.attach_id));
  return MinutesRunStateSchema.parse({
    session_id: state.session_id,
    run_id: state.run_id,
    last_revision: Math.max(state.last_revision, artifact.revision),
    updated_at: nowIso,
    artifacts,
  });
}

function existingSuccessfulArtifact(state: MinutesRunState, attachId: string): MinutesRunArtifact | undefined {
  return state.artifacts.find((item) => item.attach_id === attachId && item.attach_failed === false);
}

function toArtifact(
  request: MinutesFetchRequest,
  nowIso: string,
  patch: Partial<Pick<MinutesRunArtifact, 'minute_title' | 'source_url' | 'fetched_at' | 'artifact_path' | 'content_digest' | 'attach_failed' | 'last_error'>>,
): MinutesRunArtifact {
  return MinutesRunArtifactSchema.parse({
    request_id: request.request_id,
    session_id: request.session_id,
    run_id: request.run_id,
    revision: request.revision,
    minute_id: request.minute_id,
    content_kind: request.content_kind,
    requested_at: request.requested_at,
    attach_id: buildAttachId(request),
    minute_title: patch.minute_title ?? request.minute_id,
    source_url: patch.source_url ?? null,
    fetched_at: patch.fetched_at ?? null,
    artifact_path: patch.artifact_path ?? null,
    content_digest: patch.content_digest ?? null,
    attached_at: nowIso,
    attach_failed: patch.attach_failed ?? false,
    last_error: patch.last_error ?? null,
  });
}

export type AttachMinutesContentOptions = {
  dataDir: string;
  botId?: string;
  request: MinutesFetchRequest;
  content: MinutesContent;
  nowFn?: () => number;
};

export type AttachMinutesContentResult = {
  attach_failed: boolean;
  artifact: MinutesRunArtifact;
  state: MinutesRunState;
  statePath: string;
};

export async function attachMinutesContent(options: AttachMinutesContentOptions): Promise<AttachMinutesContentResult> {
  const request = MinutesFetchRequestSchema.parse(options.request);
  const content = MinutesContentSchema.parse(options.content);
  const nowFn = options.nowFn ?? Date.now;
  const nowIso = new Date(nowFn()).toISOString();
  const botId = options.botId ?? 'default';
  const statePath = runMinutesStatePath(options.dataDir, request.run_id, botId);
  const current = readMinutesState(statePath, request, nowIso);
  const attachId = buildAttachId(request);
  const existing = existingSuccessfulArtifact(current, attachId);
  if (existing) {
    return {
      attach_failed: false,
      artifact: existing,
      state: current,
      statePath,
    };
  }

  try {
    const artifactPath = buildArtifactPath(options.dataDir, request.run_id, attachId, botId);
    const body = buildArtifactBody(request, content);
    atomicWrite(artifactPath, body);
    const artifact = toArtifact(request, nowIso, {
      minute_title: content.title,
      source_url: content.source_url,
      fetched_at: content.fetched_at,
      artifact_path: artifactPath,
      content_digest: createHash('sha1').update(body).digest('hex'),
      attach_failed: false,
      last_error: null,
    });
    const nextState = mergeMinutesState(current, artifact, nowIso);
    writeMinutesState(statePath, nextState);
    return {
      attach_failed: false,
      artifact,
      state: nextState,
      statePath,
    };
  } catch (error) {
    const artifact = toArtifact(request, nowIso, {
      minute_title: content.title,
      source_url: content.source_url,
      fetched_at: content.fetched_at,
      artifact_path: null,
      content_digest: null,
      attach_failed: true,
      last_error: error instanceof Error ? error.message : String(error),
    });
    const nextState = mergeMinutesState(current, artifact, nowIso);
    writeMinutesState(statePath, nextState);
    return {
      attach_failed: true,
      artifact,
      state: nextState,
      statePath,
    };
  }
}

export type FetchMinutesToRunOptions = {
  dataDir: string;
  botId?: string;
  request: MinutesFetchRequest;
  client: MinutesClient;
  nowFn?: () => number;
};

export async function fetchMinutesToRun(options: FetchMinutesToRunOptions): Promise<AttachMinutesContentResult> {
  const request = MinutesFetchRequestSchema.parse(options.request);
  const nowFn = options.nowFn ?? Date.now;
  const nowIso = new Date(nowFn()).toISOString();
  const botId = options.botId ?? 'default';
  const statePath = runMinutesStatePath(options.dataDir, request.run_id, botId);
  const current = readMinutesState(statePath, request, nowIso);
  const attachId = buildAttachId(request);
  const existing = existingSuccessfulArtifact(current, attachId);
  if (existing) {
    return {
      attach_failed: false,
      artifact: existing,
      state: current,
      statePath,
    };
  }

  try {
    const content = await options.client.fetchMinutes(request);
    return attachMinutesContent({
      dataDir: options.dataDir,
      botId,
      request,
      content,
      nowFn,
    });
  } catch (error) {
    const artifact = toArtifact(request, nowIso, {
      minute_title: request.minute_id,
      attach_failed: true,
      last_error: error instanceof Error ? error.message : String(error),
    });
    const nextState = mergeMinutesState(current, artifact, nowIso);
    writeMinutesState(statePath, nextState);
    return {
      attach_failed: true,
      artifact,
      state: nextState,
      statePath,
    };
  }
}
