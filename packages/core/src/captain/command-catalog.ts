import { CAPTAIN_ERROR_CODES, CaptainError, CommandCatalogEntrySchema, type CommandCatalog } from './contracts.js';

export const COMMAND_CATALOG: CommandCatalog = {
  history: CommandCatalogEntrySchema.parse({ name: 'history', aliases: ['/wb history', 'wb history'], belongs_to: 'both', capability_tags: ['run-registry', 'read-only'], im_visible: true, cli_visible: true, description: 'Query run history from Run Registry' }),
  resume: CommandCatalogEntrySchema.parse({ name: 'resume', aliases: ['/wb resume --inherit', 'wb resume --inherit'], belongs_to: 'both', capability_tags: ['run-registry', 'session'], im_visible: true, cli_visible: true, description: 'Resume from an inherited run' }),
  health: CommandCatalogEntrySchema.parse({ name: 'health', aliases: ['/health', 'wb health'], belongs_to: 'both', capability_tags: ['ops', 'health'], im_visible: true, cli_visible: true, description: 'Show health checks' }),
  status: CommandCatalogEntrySchema.parse({ name: 'status', aliases: ['/status', 'wb status'], belongs_to: 'both', capability_tags: ['ops', 'session'], im_visible: true, cli_visible: true, description: 'Show current session status' }),
  logs: CommandCatalogEntrySchema.parse({ name: 'logs', aliases: ['/logs', 'wb logs'], belongs_to: 'both', capability_tags: ['ops', 'read-only'], im_visible: true, cli_visible: true, description: 'Show run logs' }),
  'list-agents': CommandCatalogEntrySchema.parse({ name: 'list-agents', aliases: ['/list-agents', '/agents', 'wb list-agents'], belongs_to: 'both', capability_tags: ['agent-registry'], im_visible: true, cli_visible: true, description: 'List registered agents' }),
  use: CommandCatalogEntrySchema.parse({ name: 'use', aliases: ['/use', 'wb use'], belongs_to: 'both', capability_tags: ['agent-binding'], im_visible: true, cli_visible: true, description: 'Switch current agent' }),
  help: CommandCatalogEntrySchema.parse({ name: 'help', aliases: ['/help', 'wb --help'], belongs_to: 'both', capability_tags: ['discoverability'], im_visible: true, cli_visible: true, description: 'Show command help' }),
  captain: CommandCatalogEntrySchema.parse({ name: 'captain', aliases: ['/wb captain', 'wb captain'], belongs_to: 'both', capability_tags: ['captain'], im_visible: true, cli_visible: true, description: 'List known captains and current binding' }),
  list: CommandCatalogEntrySchema.parse({ name: 'list', aliases: ['wb list', 'wb list --all-captains'], belongs_to: 'cli', capability_tags: ['captain', 'aggregation'], im_visible: false, cli_visible: true, description: 'Aggregate captain-visible runs (all captains)' }),
  audit: CommandCatalogEntrySchema.parse({ name: 'audit', aliases: ['wb audit', '/wb audit'], belongs_to: 'both', capability_tags: ['audit-pipe', 'read-only'], im_visible: true, cli_visible: true, description: 'View local audit mirror tail (M12-D / M13-F)' }),
  approval: CommandCatalogEntrySchema.parse({ name: 'approval', aliases: ['wb approval', '/wb approval'], belongs_to: 'both', capability_tags: ['approval-gate', 'read-only'], im_visible: true, cli_visible: true, description: 'List local approval gate queue (M12-D / M13-F)' }),
  watch: CommandCatalogEntrySchema.parse({ name: 'watch', aliases: ['wb watch', '/wb watch'], belongs_to: 'cli', capability_tags: ['reverse-channel', 'stream'], im_visible: false, cli_visible: true, description: 'Tail reverse-channel IPC events for a session (M12-D)' }),
  'captain-use': CommandCatalogEntrySchema.parse({ name: 'captain-use', aliases: ['wb captain use'], belongs_to: 'cli', capability_tags: ['captain', 'binding'], im_visible: false, cli_visible: true, description: 'Bind current CLI session to a captain' }),
  attach: CommandCatalogEntrySchema.parse({ name: 'attach', aliases: ['wb attach'], belongs_to: 'cli', capability_tags: ['reverse-channel.attach'], im_visible: false, cli_visible: true, description: 'Attach a CLI session to an existing captain session' }),
  'pause-im': CommandCatalogEntrySchema.parse({ name: 'pause-im', aliases: ['@wb pause <run_id>'], belongs_to: 'bot', capability_tags: ['reverse-channel.pause'], im_visible: false, cli_visible: false, description: 'Reverse @ pause trigger from IM sender' }),
  'resume-im': CommandCatalogEntrySchema.parse({ name: 'resume-im', aliases: ['@wb resume <run_id>'], belongs_to: 'bot', capability_tags: ['reverse-channel.resume'], im_visible: false, cli_visible: false, description: 'Reverse @ resume trigger from IM sender' }),
  'cancel-im': CommandCatalogEntrySchema.parse({ name: 'cancel-im', aliases: ['@wb cancel <run_id>'], belongs_to: 'bot', capability_tags: ['reverse-channel.cancel'], im_visible: false, cli_visible: false, description: 'Reverse @ cancel trigger from IM sender' }),
  runs: CommandCatalogEntrySchema.parse({ name: 'runs', aliases: ['wb runs'], belongs_to: 'cli', capability_tags: ['run-registry'], im_visible: false, cli_visible: true, description: 'List recent runs' }),
  debug: CommandCatalogEntrySchema.parse({ name: 'debug', aliases: ['wb debug'], belongs_to: 'cli', capability_tags: ['debug'], im_visible: false, cli_visible: true, description: 'Run an agent in foreground debug mode' }),
  now: CommandCatalogEntrySchema.parse({ name: 'now', aliases: ['/now'], belongs_to: 'bot', capability_tags: ['session'], im_visible: true, cli_visible: false, description: 'Show current thread binding' }),
  'reset-context': CommandCatalogEntrySchema.parse({ name: 'reset-context', aliases: ['/reset-context'], belongs_to: 'bot', capability_tags: ['session'], im_visible: true, cli_visible: false, description: 'Clear current continuation token' }),
  stop: CommandCatalogEntrySchema.parse({ name: 'stop', aliases: ['/stop'], belongs_to: 'bot', capability_tags: ['ops'], im_visible: true, cli_visible: false, description: 'Stop current run' }),
  'stop-all': CommandCatalogEntrySchema.parse({ name: 'stop-all', aliases: ['/stop-all'], belongs_to: 'bot', capability_tags: ['ops', 'captain'], im_visible: true, cli_visible: false, description: 'Send stop signal to all active runs' }),
  follow: CommandCatalogEntrySchema.parse({ name: 'follow', aliases: ['/follow'], belongs_to: 'bot', capability_tags: ['notifications'], im_visible: true, cli_visible: false, description: 'Notify when current thread finishes' }),
  tasks: CommandCatalogEntrySchema.parse({ name: 'tasks', aliases: ['/tasks'], belongs_to: 'bot', capability_tags: ['history'], im_visible: true, cli_visible: false, description: 'Show task history' }),
  'list-bots': CommandCatalogEntrySchema.parse({ name: 'list-bots', aliases: ['/list-bots'], belongs_to: 'bot', capability_tags: ['captain'], im_visible: true, cli_visible: false, description: 'List configured bots' }),
  cwd: CommandCatalogEntrySchema.parse({ name: 'cwd', aliases: ['/cwd'], belongs_to: 'bot', capability_tags: ['cwd'], im_visible: true, cli_visible: false, description: 'Set thread cwd' }),
  'cwd-add': CommandCatalogEntrySchema.parse({ name: 'cwd-add', aliases: ['/cwd-add'], belongs_to: 'bot', capability_tags: ['cwd'], im_visible: true, cli_visible: false, description: 'Add cwd alias' }),
  'cwd-list': CommandCatalogEntrySchema.parse({ name: 'cwd-list', aliases: ['/cwd-list'], belongs_to: 'bot', capability_tags: ['cwd'], im_visible: true, cli_visible: false, description: 'List cwd aliases' }),
  'cwd-rm': CommandCatalogEntrySchema.parse({ name: 'cwd-rm', aliases: ['/cwd-rm'], belongs_to: 'bot', capability_tags: ['cwd'], im_visible: true, cli_visible: false, description: 'Remove cwd alias' }),
  sync: CommandCatalogEntrySchema.parse({ name: 'sync', aliases: ['/wb sync'], belongs_to: 'bot', capability_tags: ['group-sync'], im_visible: true, cli_visible: false, description: 'Trigger a one-shot group sync mock run (M11-C)' }),
};

export function validateCatalog(registeredCommands: string[]): void {
  const missing = registeredCommands.filter((command) => !COMMAND_CATALOG[command]);
  if (missing.length > 0) {
    throw new CaptainError(CAPTAIN_ERROR_CODES.E_CATALOG_INCOMPLETE, `missing commands in catalog: ${missing.join(', ')}`);
  }
}
