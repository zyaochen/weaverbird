#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { WbRunner, type RunSpec } from './wb-runner.js';

const specJsonPath = process.argv[2];

if (!specJsonPath) {
  process.stderr.write('usage: wb-runner-main <specJsonPath>\n');
  process.exit(1);
}

let spec: RunSpec;
try {
  const raw = readFileSync(resolve(specJsonPath), 'utf8');
  spec = JSON.parse(raw) as RunSpec;
} catch (err) {
  process.stderr.write(`failed to read spec: ${(err as Error).message}\n`);
  process.exit(1);
}

// specJsonPath = <dataDir>/runs/<botId>/<runId>/spec.json → dataDir is 3 levels up from spec.json dir
const dataDir = dirname(dirname(dirname(dirname(resolve(specJsonPath)))));
const runner = new WbRunner(dataDir, spec);

runner.start().then(() => {
  process.exit(0);
}).catch((err) => {
  process.stderr.write(`wb-runner fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
