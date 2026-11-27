const events = JSON.parse(process.env.FIXTURE_EVENTS ?? '[]');
const intervalMs = Number(process.env.FIXTURE_INTERVAL_MS ?? '10');
const keepAlive = process.env.FIXTURE_KEEP_ALIVE === '1';
const termBehavior = process.env.FIXTURE_TERM_BEHAVIOR ?? 'exit';
const termDelayMs = Number(process.env.FIXTURE_TERM_DELAY_MS ?? '0');
const stderrLines = JSON.parse(process.env.FIXTURE_STDERR_LINES ?? '[]');
const emitCwd = process.env.FIXTURE_EMIT_CWD === '1';
const emitEnvKey = process.env.FIXTURE_EMIT_ENV_KEY ?? '';
const readStdin = process.env.FIXTURE_READ_STDIN === '1';
const exitCode = Number(process.env.FIXTURE_EXIT_CODE ?? '0');

process.on('SIGTERM', () => {
  if (termBehavior === 'ignore') {
    return;
  }
  setTimeout(() => process.exit(0), termDelayMs);
});

function buildPrefixEvents() {
  const prefix = [];
  if (emitCwd) prefix.push({ type: 'text', delta: `cwd:${process.cwd()}` });
  if (emitEnvKey) prefix.push({ type: 'text', delta: `env:${emitEnvKey}=${process.env[emitEnvKey] ?? ''}` });
  return prefix;
}

function startEventStream(stdinText = '') {
  const allEvents = [...buildPrefixEvents(), ...events];
  if (readStdin) allEvents.unshift({ type: 'text', delta: `stdin:${stdinText}` });

  function writeEvent(index) {
    if (index >= allEvents.length) {
      if (!keepAlive) process.exit(exitCode);
      return;
    }
    process.stdout.write(`${JSON.stringify(allEvents[index])}\n`);
    setTimeout(() => writeEvent(index + 1), intervalMs);
  }

  writeEvent(0);
}

for (const line of stderrLines) {
  process.stderr.write(`${line}\n`);
}

if (readStdin) {
  let stdinText = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdinText += chunk;
  });
  process.stdin.on('end', () => {
    startEventStream(stdinText.trimEnd());
  });
} else {
  startEventStream();
}

if (keepAlive) setInterval(() => {}, 1000);
