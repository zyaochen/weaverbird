import { chmodSync, existsSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import net, { type Server, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { IPC_SOCKET_PATH, IpcMessageSchema, REVERSE_CHANNEL_ERROR_CODES, ReverseChannelError, type IpcMessage } from './contracts.js';

type ConnectionRecord = {
  socket: Socket;
  pid: number;
  runId: string;
  buffer: string;
};

type IpcServerEvents = {
  hello: (message: Extract<IpcMessage, { kind: 'hello' }>) => void;
  control: (message: Extract<IpcMessage, { kind: 'control' }>) => void;
  attach: (message: Extract<IpcMessage, { kind: 'attach' }>) => void;
  bye: (message: Extract<IpcMessage, { kind: 'bye' }>) => void;
};

function resolveSocketPath(socketPath: string): string {
  return socketPath.startsWith('~/') ? resolve(process.env['HOME'] ?? '', socketPath.slice(2)) : resolve(socketPath);
}

export class IpcServer extends EventEmitter {
  private readonly socketPath: string;
  private server: Server | null = null;
  private readonly connections = new Map<string, ConnectionRecord>();

  constructor(socketPath = IPC_SOCKET_PATH) {
    super();
    this.socketPath = resolveSocketPath(socketPath);
  }

  override on<K extends keyof IpcServerEvents>(event: K, listener: IpcServerEvents[K]): this {
    return super.on(event, listener);
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.socketPath), { recursive: true });
    this.resetStaleSocket();
    this.server = net.createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolvePromise, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off('error', reject);
        chmodSync(this.socketPath, 0o600);
        resolvePromise();
      });
    });
  }

  async stop(): Promise<void> {
    for (const connection of this.connections.values()) {
      connection.socket.destroy();
    }
    this.connections.clear();
    if (!this.server) return;
    await new Promise<void>((resolvePromise) => {
      this.server!.close(() => resolvePromise());
    });
    this.server = null;
    if (existsSync(this.socketPath)) rmSync(this.socketPath, { force: true });
  }

  async close(): Promise<void> {
    await this.stop();
  }

  send(runId: string, message: IpcMessage): boolean {
    const connection = this.connections.get(runId);
    if (!connection) return false;
    connection.socket.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  private resetStaleSocket(): void {
    if (!existsSync(this.socketPath)) return;
    const mode = statSync(this.socketPath).mode & 0o777;
    if (mode !== 0o600) {
      console.warn(`[reverse-channel] socket mode ${mode.toString(8)} != 600, recreating`);
    }
    rmSync(this.socketPath, { force: true });
  }

  private handleSocket(socket: Socket): void {
    const record: ConnectionRecord = { socket, pid: 0, runId: '', buffer: '' };
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      record.buffer += chunk;
      const lines = record.buffer.split('\n');
      record.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleLine(record, line);
      }
    });
    socket.on('close', () => {
      if (record.runId) this.connections.delete(record.runId);
    });
    socket.on('error', () => {
      if (record.runId) this.connections.delete(record.runId);
    });
  }

  private handleLine(connection: ConnectionRecord, line: string): void {
    let parsed: IpcMessage;
    try {
      parsed = IpcMessageSchema.parse(JSON.parse(line));
    } catch {
      connection.socket.write(
        `${JSON.stringify({ kind: 'ack', command: 'parse', run_id: connection.runId || 'unknown', ok: false, reason: REVERSE_CHANNEL_ERROR_CODES.E_IPC_PARSE })}\n`,
        () => connection.socket.end(),
      );
      return;
    }

    if (parsed.kind === 'hello') {
      connection.pid = parsed.pid;
      connection.runId = parsed.run_id;
      this.connections.set(parsed.run_id, connection);
      this.emit('hello', parsed);
      connection.socket.write(`${JSON.stringify({ kind: 'ack', command: 'hello', run_id: parsed.run_id, ok: true, reason: 'hello-ack' })}\n`);
      return;
    }

    if (parsed.kind === 'ping') {
      connection.socket.write(`${JSON.stringify({ kind: 'pong' })}\n`);
      return;
    }

    if (parsed.kind === 'control') {
      this.emit('control', parsed);
      return;
    }

    if (parsed.kind === 'attach') {
      this.emit('attach', parsed);
      return;
    }

    if (parsed.kind === 'bye') {
      this.emit('bye', parsed);
      if (parsed.run_id) this.connections.delete(parsed.run_id);
      connection.socket.write(`${JSON.stringify({ kind: 'ack', command: 'bye', run_id: parsed.run_id, ok: true })}\n`, () => {
        connection.socket.end();
      });
    }
  }
}
