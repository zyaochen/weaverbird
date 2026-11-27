import { EchoPayloadSchema, ECHO_CMD_PREVIEW_MAX, ECHO_MAX_PER_RUN, type EchoPayload, type SessionRecord } from './contracts.js';

type MessageSink = (payload: EchoPayload) => Promise<void>;

type EchoTailerOptions = {
  messageSink: MessageSink;
  nowFn?: () => number;
};

export class EchoTailer {
  private readonly messageSink: MessageSink;
  private readonly nowFn: () => number;
  private readonly lastEchoMap = new Map<string, number>();
  private readonly sentPerRun = new Map<string, number>();

  constructor(messageSink: MessageSink, options: Omit<EchoTailerOptions, 'messageSink'> = {}) {
    this.messageSink = messageSink;
    this.nowFn = options.nowFn ?? Date.now;
  }

  async onRunUpserted(input: {
    run_id: string;
    cmd: string;
    cwd: string;
    created_at: string;
    status: string;
    session: SessionRecord | null;
    operator_open_id: string;
  }): Promise<boolean> {
    if (!input.session?.home_group_id) return false;
    const dedupKey = `${input.run_id}:${input.status}`;
    const last = this.lastEchoMap.get(dedupKey);
    if (last !== undefined && this.nowFn() - last < 30_000) return false;
    const count = this.sentPerRun.get(input.run_id) ?? 0;
    if (count >= ECHO_MAX_PER_RUN) return false;
    this.lastEchoMap.set(dedupKey, this.nowFn());
    this.sentPerRun.set(input.run_id, count + 1);
    const payload = EchoPayloadSchema.parse({
      run_id: input.run_id,
      cmd_preview: input.cmd.slice(0, ECHO_CMD_PREVIEW_MAX),
      cwd: input.cwd,
      created_at: input.created_at,
      status: input.status,
      session_id: input.session.session_id,
      home_group_id: input.session.home_group_id,
      operator_open_id: input.operator_open_id,
    });
    await this.messageSink(payload);
    return true;
  }
}
