import { IpcClient, type AttachRequest, type AttachResult } from '../../../../packages/core/src/reverse-channel/index.js';

export async function attachCommand(argv: string[]): Promise<number> {
  const sessionId = argv[0];
  if (!sessionId) {
    process.stderr.write('Usage: wb-cli attach <session_id>\n');
    return 1;
  }
  const client = new IpcClient();
  const connection = await client.openSession();
  try {
    await connection.send({ kind: 'hello', run_id: sessionId, pid: process.pid });
    const request: AttachRequest = {
      session_id: sessionId,
      requester_captain_id: process.env['BOT_ID'] ?? 'default',
      requested_at: new Date().toISOString(),
      force: argv.includes('--force'),
    };
    const ack = await connection.send({
      kind: 'attach',
      run_id: request.session_id,
      session_id: request.session_id,
      requester_captain_id: request.requester_captain_id,
      force: request.force,
    });
    process.stdout.write(`${JSON.stringify({ session_id: sessionId, ack })}\n`);
    return 0;
  } finally {
    await connection.close();
  }
}
