import pino, { type Logger } from 'pino';
import { errorSerializers } from './log-redact.js';

export type PatchHandler = (card: Record<string, unknown>) => Promise<void>;

type CardPipelineOptions = {
  minIntervalMs?: number;
  logger?: Logger;
  label?: string;
};

const defaultLogger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', serializers: errorSerializers });

function extractPatchErrorDetails(error: unknown): { message: string; code?: number; detail: string } {
  const message = error instanceof Error ? error.message : String(error);
  const response = typeof error === 'object' && error !== null && 'response' in error
    ? (error as { response?: { data?: { code?: number; msg?: string } } }).response
    : undefined;
  return {
    message,
    code: response?.data?.code,
    detail: response?.data?.msg ?? '',
  };
}

function isRetryablePatchError(details: { message: string; code?: number; detail: string }): boolean {
  return details.message.includes('230020')
    || details.message.includes('230099')
    || details.message.includes('card action is lock')
    || details.code === 230020
    || details.code === 230099
    || details.code === 99991400
    || details.detail.includes('card action is lock');
}

export class CardPipeline {
  private pending: Record<string, unknown> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private backoffMs: number;
  private readonly minIntervalMs: number;
  private readonly logger: Logger;
  private readonly label: string;
  private isPatching = false;

  constructor(private readonly patch: PatchHandler, minIntervalOrOptions: number | CardPipelineOptions = 800) {
    const options = typeof minIntervalOrOptions === 'number'
      ? { minIntervalMs: minIntervalOrOptions }
      : minIntervalOrOptions;
    this.minIntervalMs = options.minIntervalMs ?? 800;
    this.backoffMs = this.minIntervalMs;
    this.logger = options.logger ?? defaultLogger;
    this.label = options.label ?? 'card-pipeline';
  }

  async flush(card: Record<string, unknown>): Promise<void> {
    this.pending = card;
    if (this.timer) {
      this.logger.debug({ label: this.label, hasPending: true }, 'card patch already scheduled');
      return;
    }
    // If a patch is already in-flight, just leave the payload in pending —
    // drain() will re-schedule when the current patch settles.
    if (this.isPatching) {
      this.logger.debug({ label: this.label, hasPending: true }, 'card patch in-flight, queued flush');
      return;
    }
    this.logger.debug({ label: this.label, delayMs: this.minIntervalMs }, 'scheduled card patch flush');
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain('flush-timer');
    }, this.minIntervalMs);
  }

  async force(card: Record<string, unknown>): Promise<void> {
    this.pending = card;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.logger.info({ label: this.label }, 'cleared pending card patch timer before force');
    }
    if (this.isPatching) {
      // A patch is in-flight; the updated pending will be drained when it settles.
      this.logger.info({ label: this.label }, 'card patch in-flight, force queued for after current patch');
      return;
    }
    await this.drain('force');
  }

  private async drain(trigger: 'force' | 'flush-timer' | 'retry-timer'): Promise<void> {
    const card = this.pending;
    this.pending = null;
    if (!card) {
      this.logger.info({ label: this.label, trigger }, 'skipped card patch drain with no pending payload');
      return;
    }
    this.isPatching = true;
    try {
      this.logger.info({ label: this.label, trigger, payloadSize: JSON.stringify(card).length }, 'patching card');
      await this.patch(card);
      this.backoffMs = this.minIntervalMs;
      this.logger.info({ label: this.label, trigger }, 'patched card successfully');
      // Drain any payload that arrived while we were in-flight.
      if (this.pending && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.drain('flush-timer');
        }, this.minIntervalMs);
      }
    } catch (error) {
      const details = extractPatchErrorDetails(error);
      if (!isRetryablePatchError(details)) {
        this.logger.error({ label: this.label, trigger, ...details, error }, 'card patch failed without retry');
        throw error;
      }
      this.pending = card;
      const retryMs = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 3200);
      this.logger.warn({
        label: this.label,
        trigger,
        retryMs,
        nextBackoffMs: this.backoffMs,
        ...details,
      }, 'card patch failed with retryable error');
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.drain('retry-timer');
      }, retryMs);
    } finally {
      this.isPatching = false;
    }
  }
}
