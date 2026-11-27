import { CardPipeline } from '../../../../apps/wb-bot/src/feishu/card-pipeline.js';
import { RUN_OBSERVABILITY_ERROR_CODES, type ObservabilityStoreEntry } from './contracts.js';
import { renderProgressCard } from './card-renderer-progress.js';

export class CardRefresher {
  constructor(
    private readonly pipeline: CardPipeline,
    private readonly markPatchFailed: (entry: ObservabilityStoreEntry, code: string) => Promise<void> | void,
    private readonly nowFn: () => string = () => new Date().toISOString(),
  ) {}

  async refresh(entry: ObservabilityStoreEntry, latestLine: string | null): Promise<void> {
    const card = renderProgressCard(entry, latestLine, this.nowFn());
    try {
      await this.pipeline.flush(card);
    } catch {
      await this.markPatchFailed(entry, RUN_OBSERVABILITY_ERROR_CODES.E_IM_PATCH_FAILED);
    }
  }

  async finalize(entry: ObservabilityStoreEntry, latestLine: string | null): Promise<void> {
    const card = renderProgressCard(entry, latestLine, this.nowFn());
    try {
      await this.pipeline.force(card);
    } catch {
      await this.markPatchFailed(entry, RUN_OBSERVABILITY_ERROR_CODES.E_IM_PATCH_FAILED);
    }
  }
}
