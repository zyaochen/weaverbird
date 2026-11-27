declare module 'pino-roll' {
  import type { Writable } from 'node:stream';
  export type PinoRollOptions = {
    file: string;
    size?: string | number;
    frequency?: 'daily' | 'hourly' | number | (() => number);
    extension?: string;
    limit?: { count?: number; removeOtherLogFiles?: boolean };
    symlink?: boolean;
    dateFormat?: string;
    mkdir?: boolean;
    mode?: number;
    [key: string]: unknown;
  };
  const pinoRoll: (opts?: PinoRollOptions) => Promise<Writable>;
  export default pinoRoll;
}
