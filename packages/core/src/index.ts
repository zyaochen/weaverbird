export * from './agent/index.js';
export {
  WbRunner,
  type RunSpec,
  type RunStatus,
  CURRENT_SCHEMA_VERSION,
  HEARTBEAT_INTERVAL_MS,
  STOP_POLL_INTERVAL_MS,
  STOP_GRACE_MS,
  validateRunCwd,
  validateSpecId,
} from './runner/wb-runner.js';
export { replayEventsFromNdjson, SUPPORTED_SCHEMA_VERSION, type ReplayResult } from './runner/event-replay.js';
export { startAuditPipe, type StartAuditPipeOptions } from './audit-pipe/index.js';
export * from './audit-pipe/contracts.js';
export * from './run-registry/index.js';
export * from './calendar-hook/index.js';
export * from './group-sync/index.js';
export * from './periodic-tasks/index.js';
export * from './approval-gate/contracts.js';
export * from './approval-gate/matcher.js';
export * from './approval-gate/audit.js';
export * from './captain/index.js';
export * from './paths.js';
export * from './config/errors.js';
export * from './config/registry.js';
export * from './errors/codes.js';
// M12-D (2026-08-04): IpcClient + error 类, 让 wb-cli `watch`/`attach` 不必走
// 深层相对路径。不在此处导出 reverse-channel/contracts,因为那些 schema 与
// captain contracts 互相引用,会造成 runtime circular import;调用方按需
// `import { IpcMessageSchema } from '../../packages/core/src/reverse-channel/contracts.js'`.
export { IpcClient, type IpcSessionConnection } from './reverse-channel/ipc-client.js';
export { ReverseChannelError, REVERSE_CHANNEL_ERROR_CODES } from './reverse-channel/contracts.js';

