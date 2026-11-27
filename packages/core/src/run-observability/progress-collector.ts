import type { Readable } from 'node:stream';
import { ProgressStore, type ProgressStoreAppendResult } from './progress-store.js';

export class ProgressCollector {
  private readonly buffers: Record<'stdout' | 'stderr', string> = {
    stdout: '',
    stderr: '',
  };
  private lineIndex = 0;

  constructor(
    private readonly store: ProgressStore,
    private readonly nowFn: () => string = () => new Date().toISOString(),
  ) {}

  attach(streams: { stdout?: Readable | null; stderr?: Readable | null }): () => void {
    const listeners: Array<() => void> = [];
    for (const [source, stream] of Object.entries(streams) as Array<['stdout' | 'stderr', Readable | null | undefined]>) {
      if (!stream) continue;
      const onData = (chunk: Buffer | string) => {
        this.push(source, typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      };
      stream.on('data', onData);
      listeners.push(() => stream.off('data', onData));
    }
    return () => listeners.forEach((off) => off());
  }

  push(source: 'stdout' | 'stderr', chunk: string): ProgressStoreAppendResult[] {
    this.buffers[source] += chunk;
    const lines = this.buffers[source].split('\n');
    this.buffers[source] = lines.pop() ?? '';
    return lines.filter((line) => line.length > 0).map((line) => this.appendLine(source, line));
  }

  flush(): ProgressStoreAppendResult[] {
    const results: ProgressStoreAppendResult[] = [];
    for (const source of ['stdout', 'stderr'] as const) {
      if (!this.buffers[source]) continue;
      results.push(this.appendLine(source, this.buffers[source]));
      this.buffers[source] = '';
    }
    return results;
  }

  private appendLine(source: 'stdout' | 'stderr', text: string): ProgressStoreAppendResult {
    const result = this.store.append({
      lineIndex: this.lineIndex,
      source,
      text,
      ts: this.nowFn(),
    });
    this.lineIndex += 1;
    return result;
  }
}
