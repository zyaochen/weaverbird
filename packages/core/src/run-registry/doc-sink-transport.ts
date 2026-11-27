import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUN_REGISTRY_ERROR_CODES, RunRegistryError } from './contracts.js';

export type DocSinkTransportInput = {
  runId: string;
  title: string;
  body: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type DocSinkTransportResult = {
  url: string;
  rawOutput: string;
};

export interface DocSinkTransport {
  create(input: DocSinkTransportInput): Promise<DocSinkTransportResult>;
}

export type CreateLarkDocTransportOptions = {
  command?: string;
  args?: string[];
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const URL_PATTERN = /https:\/\/[^\s"']+/g;
const DOC_URL_PATTERN = /^https:\/\/[\w.-]+\/.+\/(?:docx|docs)\//i;

function resolveCommand(command: string): string {
  if (command.includes('/')) return resolve(command);
  return command;
}

function findDocUrl(output: string): string | null {
  const urls = output.match(URL_PATTERN) ?? [];
  return urls.find((url) => DOC_URL_PATTERN.test(url)) ?? null;
}

export function createLarkDocTransport(options: CreateLarkDocTransportOptions = {}): DocSinkTransport {
  const baseArgs = options.args ?? ['docs', '+create', '--doc-format', 'markdown'];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async create(input: DocSinkTransportInput): Promise<DocSinkTransportResult> {
      const command = resolveCommand(options.command ?? 'lark-cli');
      if (command.includes('/') && !existsSync(command)) {
        throw new RunRegistryError(RUN_REGISTRY_ERROR_CODES.E_DOC_SINK_WRITE, `doc sink command not found: ${command}`);
      }
      const args = [...baseArgs, '--title', input.title, '--content', input.body];
      const child = spawn(command, args, {
        cwd: input.cwd,
        env: input.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));

      const result = await new Promise<DocSinkTransportResult>((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new RunRegistryError(RUN_REGISTRY_ERROR_CODES.E_DOC_SINK_WRITE, `doc sink timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.once('error', (error) => {
          clearTimeout(timer);
          reject(new RunRegistryError(RUN_REGISTRY_ERROR_CODES.E_DOC_SINK_WRITE, 'doc sink spawn failed', error));
        });

        child.once('close', (code) => {
          clearTimeout(timer);
          const output = Buffer.concat([...stdout, ...stderr]).toString('utf8').trim();
          if (code !== 0) {
            reject(new RunRegistryError(RUN_REGISTRY_ERROR_CODES.E_DOC_SINK_WRITE, output || `doc sink exited with code ${code ?? -1}`));
            return;
          }
          const url = findDocUrl(output);
          if (!url) {
            reject(new RunRegistryError(RUN_REGISTRY_ERROR_CODES.E_DOC_SINK_WRITE, `doc sink did not return a doc url: ${output || '<empty>'}`));
            return;
          }
          resolvePromise({ url, rawOutput: output });
        });
      });

      return result;
    },
  };
}
