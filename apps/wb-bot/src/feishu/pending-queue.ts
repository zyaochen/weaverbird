import type { MessageEvent } from './event-handler.js';

/**
 * 连发合并. 飞书里人习惯把一件事拆成几条发 (先贴报错、再补一句"帮我看下"),
 * 或者长文本被客户端自动切成多条. 逐条起 run 会让第一条在信息不全时就开跑.
 *
 * 两层:
 * - InboundDebouncer (transport 用): 同一 user+thread 在静默窗口内的连发合并成一条再交给 handler.
 *   slash 命令不进窗口, 但会先把同 scope 已攒的消息冲出去, 保证先后顺序.
 * - mergeMessageEvents (handler 用): run 进行中收到的消息排队, run 结束后合并成下一轮.
 */

export const DEFAULT_DEBOUNCE_MS = 600;
const MAX_BATCH = 10;

export function debounceMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['WB_MESSAGE_DEBOUNCE_MS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_DEBOUNCE_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DEBOUNCE_MS;
}

function concat<T>(events: MessageEvent[], pick: (event: MessageEvent) => T[] | undefined): T[] | undefined {
  const all = events.flatMap((event) => pick(event) ?? []);
  return all.length > 0 ? all : undefined;
}

/**
 * 合并多条消息: 正文按顺序空行拼接, 资源 / 附件 / 告警拼接; 回复挂在最后一条下面,
 * 其余消息 id 进 mergedMessageIds (用于撤 Typing 表情). 引用取第一条带引用的.
 */
export function mergeMessageEvents(events: MessageEvent[]): MessageEvent {
  if (events.length === 0) throw new Error('mergeMessageEvents: empty batch');
  if (events.length === 1) return events[0]!;
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const merged: MessageEvent = {
    ...last,
    eventId: `${first.eventId}+${events.length - 1}`,
    text: events.map((event) => event.text).filter((text) => text.trim()).join('\n\n'),
    mergedMessageIds: events.flatMap((event) => [...(event.mergedMessageIds ?? []), event.messageId]).filter((id) => id !== last.messageId),
  };
  const resources = concat(events, (event) => event.resources);
  const images = concat(events, (event) => event.images);
  const attachments = concat(events, (event) => event.attachments);
  const notices = concat(events, (event) => event.notices);
  const parentId = events.find((event) => event.parentId)?.parentId;
  delete merged.resources;
  delete merged.images;
  delete merged.attachments;
  delete merged.notices;
  delete merged.parentId;
  return {
    ...merged,
    ...(resources ? { resources } : {}),
    ...(images ? { images } : {}),
    ...(attachments ? { attachments } : {}),
    ...(notices ? { notices } : {}),
    ...(parentId ? { parentId } : {}),
  };
}

type Entry = { events: MessageEvent[]; timer: NodeJS.Timeout | null };

const SEEN_EVENT_IDS = 1000;

export class InboundDebouncer {
  private readonly entries = new Map<string, Entry>();
  // 合并后 handler 只看到合并 eventId, 原始 eventId 的重投递要在这里挡掉.
  private readonly seenEventIds = new Set<string>();

  constructor(
    private readonly delayMs: number,
    private readonly dispatch: (event: MessageEvent) => void,
  ) {}

  push(event: MessageEvent): void {
    if (event.eventId) {
      if (this.seenEventIds.has(event.eventId)) return;
      this.seenEventIds.add(event.eventId);
      if (this.seenEventIds.size > SEEN_EVENT_IDS) {
        const oldest = this.seenEventIds.values().next().value;
        if (oldest !== undefined) this.seenEventIds.delete(oldest);
      }
    }
    const scope = `${event.userOpenId}:${event.threadId}`;
    if (this.delayMs <= 0) {
      this.dispatch(event);
      return;
    }
    if (event.text.trimStart().startsWith('/')) {
      this.flush(scope);
      this.dispatch(event);
      return;
    }
    const entry = this.entries.get(scope) ?? { events: [], timer: null };
    if (entry.timer) clearTimeout(entry.timer);
    entry.events.push(event);
    this.entries.set(scope, entry);
    if (entry.events.length >= MAX_BATCH) {
      this.flush(scope);
      return;
    }
    entry.timer = setTimeout(() => this.flush(scope), this.delayMs);
    entry.timer.unref?.();
  }

  flush(scope: string): void {
    const entry = this.entries.get(scope);
    if (!entry) return;
    this.entries.delete(scope);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.events.length > 0) this.dispatch(mergeMessageEvents(entry.events));
  }

  /** 撤回: 还在静默窗口里的消息直接丢掉. 返回是否命中. */
  drop(messageId: string): boolean {
    for (const [scope, entry] of this.entries) {
      const index = entry.events.findIndex((event) => event.messageId === messageId);
      if (index === -1) continue;
      entry.events.splice(index, 1);
      if (entry.events.length === 0) {
        if (entry.timer) clearTimeout(entry.timer);
        this.entries.delete(scope);
      }
      return true;
    }
    return false;
  }

  flushAll(): void {
    for (const scope of [...this.entries.keys()]) this.flush(scope);
  }
}
