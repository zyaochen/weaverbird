import { existsSync, statSync } from 'node:fs';
import net, { type Socket } from 'node:net';
import { resolve } from 'node:path';
import { ATTACH_TIMEOUT_MS, IPC_SOCKET_PATH, IpcMessageSchema, REVERSE_CHANNEL_ERROR_CODES, ReverseChannelError, type IpcMessage } from './contracts.js';

function resolveSocketPath(socketPath: string): string {
  return socketPath.startsWith('~/') ? resolve(process.env['HOME'] ?? '', socketPath.slice(2)) : resolve(socketPath);
}

export type IpcSessionConnection = {
  send(message: IpcMessage, options?: { timeoutMs?: number }): Promise<IpcMessage>;
  on(event: 'push', listener: (message: IpcMessage) => void): void;
  close(): Promise<void>;
};

class SessionConnection implements IpcSessionConnection {
  private buffer = '';
  private readonly listeners = new Set<(message: IpcMessage) => void>();

  constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = IpcMessageSchema.parse(JSON.parse(line));
        for (const listener of this.listeners) listener(message);
      }
    });
  }

  async send(message: IpcMessage, options: { timeoutMs?: number } = {}): Promise<IpcMessage> {
    return new Promise<IpcMessage>((resolvePromise, reject) => {
      const timeout = setTimeout(
        () => reject(new ReverseChannelError(REVERSE_CHANNEL_ERROR_CODES.E_IPC_SEND_TIMEOUT, 'IPC send timed out')),
        options.timeoutMs ?? ATTACH_TIMEOUT_MS,
      );
      const handler = (incoming: IpcMessage) => {
        if (message.kind === 'ping' && incoming.kind === 'pong') {
          clearTimeout(timeout);
          this.listeners.delete(handler);
          resolvePromise(incoming);
          return;
        }
        if (incoming.kind === 'ack' && incoming.run_id === ('run_id' in message ? message.run_id : incoming.run_id)) {
          clearTimeout(timeout);
          this.listeners.delete(handler);
          resolvePromise(incoming);
        }
      };
      this.listeners.add(handler);
      this.socket.write(`${JSON.stringify(message)}\n`);
    });
  }

  on(event: 'push', listener: (message: IpcMessage) => void): void {
    if (event === 'push') this.listeners.add(listener);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      this.socket.end(() => resolvePromise());
    });
  }
}

export class IpcClient {
  private readonly socketPath: string;

  constructor(socketPath = IPC_SOCKET_PATH) {
    this.socketPath = resolveSocketPath(socketPath);
  }

  async requestOnce(message: IpcMessage, options: { timeoutMs?: number } = {}): Promise<IpcMessage> {
    const connection = await this.openSession();
    try {
      return await connection.send(message, options);
    } finally {
      await connection.close();
    }
  }

  async openSession(options: { runId?: string; pid?: number } = {}): Promise<IpcSessionConnection> {
    if (!existsSync(this.socketPath)) {
      throw new ReverseChannelError(REVERSE_CHANNEL_ERROR_CODES.E_IPC_CONNECT_FAILED, 'IPC_SOCKET_NOT_FOUND');
    }
    statSync(this.socketPath);
    const socket = await this.connect();
    const connection = new SessionConnection(socket);

    if (options.runId !== undefined) {
      const ack = await connection.send({
        kind: 'hello',
        run_id: options.runId,
        pid: options.pid ?? process.pid,
      });
      if (ack.kind !== 'ack' || !ack.ok) {
        await connection.close();
        throw new ReverseChannelError(
          REVERSE_CHANNEL_ERROR_CODES.E_IPC_CONNECT_FAILED,
          `hello ack failed: ${ack.kind === 'ack' ? (ack.reason ?? 'unknown') : 'non-ack response'}`,
        );
      }
    }

    return connection;
  }

  private async connect(): Promise<Socket> {
    const socket = new net.Socket();
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new ReverseChannelError(REVERSE_CHANNEL_ERROR_CODES.E_IPC_CONNECT_FAILED, 'IPC hello/connect timeout'));
      }, ATTACH_TIMEOUT_MS);
      socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(new ReverseChannelError(REVERSE_CHANNEL_ERROR_CODES.E_IPC_CONNECT_FAILED, error instanceof Error ? error.message : String(error), error));
      });
      socket.connect(this.socketPath, () => {
        clearTimeout(timeout);
        resolvePromise();
      });
    });
    return socket;
  }
}
