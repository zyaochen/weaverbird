import { IpcClient, ReverseChannelError, type IpcSessionConnection } from '@weaverbird/core';

export type WatchCommandOptions = {
  sessionId?: string;
  durationMs?: number;
};

export function parseWatchArgs(argv: string[]): WatchCommandOptions {
  const options: WatchCommandOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = argv[i + 1];
    if (arg === '--session' && next) {
      options.sessionId = next;
      i += 1;
      continue;
    }
    if ((arg === '-t' || arg === '--timeout') && next) {
      options.durationMs = Number.parseInt(next, 10) * 1000;
      i += 1;
      continue;
    }
    if (!options.sessionId && arg && !arg.startsWith('-')) {
      options.sessionId = arg;
    }
  }
  return options;
}

/**
 * M12-D (2026-08-04 owner-authorized, PRD §4.2 "wb-cli watch" 平价):
 * 长连 reverse-channel IPC socket,把 server 推过来的事件回显到 stdout。
 * 这条命令不动卡片、不推桌面通知 (D' 边界:不接 osascript/notify-send);
 * 真正把 stderr 送到用户端的通知工具包是 wrapper 的事, wb-cli 只保证数据流。
 *
 * 若 socket 不存在 => 返回 3,表示 "没有正在跑的 bot"; 调用 wrapper 应解读成
 * "bot offline"。
 */
export async function watchCommand(argv: string[]): Promise<number> {
  const options = parseWatchArgs(argv);
  const client = new IpcClient();
  let connection: IpcSessionConnection | null = null;
  const close = async () => {
    if (!connection) return;
    try {
      await connection.close();
    } catch {
      // swallow close errors - process is shutting down
    }
    connection = null;
  };
  process.once('SIGINT', () => { void close().then(() => process.exit(130)); });

  try {
    connection = await client.openSession(options.sessionId ? { runId: options.sessionId } : {});
  } catch (error) {
    if (error instanceof ReverseChannelError) {
      process.stderr.write(`watch connect failed: ${error.message}\n`);
      return 3;
    }
    process.stderr.write(`watch connect failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }

  const deadline = options.durationMs ? Date.now() + options.durationMs : Number.POSITIVE_INFINITY;
  process.stdout.write(`watching session=${options.sessionId ?? '(all)'}\n`);

  while (Date.now() < deadline) {
    await new Promise<void>((resolvePromise) => {
      const timeout = setTimeout(() => resolvePromise(), 1000);
      connection?.on('push', (message) => {
        clearTimeout(timeout);
        process.stdout.write(`${JSON.stringify(message)}\n`);
        resolvePromise();
      });
    });
  }

  await close();
  return 0;
}
