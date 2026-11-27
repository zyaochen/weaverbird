import { REVERSE_CHANNEL_ERROR_CODES } from './contracts.js';

export const REVERSE_CHANNEL_AUDIT_RESOURCE_PREFIX = 'reverse-channel:';

export type DecodedAuditResource = {
  verb: string;
  targetId: string;
  sender?: string;
  sig?: string;
  result?: string;
};

function sanitize(value: string): string {
  return value.replace(/[:\s]/g, '_');
}

export function redactSenderOpenId(openId: string): string {
  return `${openId.slice(0, 8)}***`;
}

function buildAndTruncate(parts: string[], maxLen = 256): string {
  let raw = parts.join(':');
  if (raw.length <= maxLen) return raw;

  const dropOrder = [
    (part: string) => part.startsWith('result=fail:reason='),
    (part: string) => part === 'result=ok',
    (part: string) => part.startsWith('sig='),
    (part: string) => part.startsWith('sender='),
    (part: string) => part.startsWith('from='),
  ];

  let working = [...parts];
  for (const matcher of dropOrder) {
    working = working.filter((part) => !matcher(part));
    raw = working.join(':');
    if (raw.length <= maxLen) return raw;
  }

  return `${raw.slice(0, maxLen - 3)}...`;
}

export function encodeAuditResource(input: {
  verb: 'attach' | 'pause' | 'resume' | 'cancel';
  targetId: string;
  senderOpenId?: string;
  signal?: 'SIGSTOP' | 'SIGCONT' | 'SIGTERM';
  result: 'ok' | 'fail';
  reasonCode?: keyof typeof REVERSE_CHANNEL_ERROR_CODES;
  fromCaptainId?: string;
}): string {
  const parts = [`${REVERSE_CHANNEL_AUDIT_RESOURCE_PREFIX}${input.verb}`, sanitize(input.targetId)];
  if (input.verb === 'attach' && input.fromCaptainId) {
    parts.push(`from=${sanitize(input.fromCaptainId)}`);
  }
  if (input.senderOpenId) {
    parts.push(`sender=${sanitize(redactSenderOpenId(input.senderOpenId))}`);
  }
  if (input.signal) {
    parts.push(`sig=${input.signal}`);
  }
  if (input.result === 'ok') {
    parts.push('result=ok');
  } else {
    parts.push(`result=fail:reason=${sanitize(input.reasonCode ?? 'unknown')}`);
  }
  return buildAndTruncate(parts);
}

export function decodeAuditResource(resource: string): DecodedAuditResource {
  const [prefix, verb, targetId = '', ...rest] = resource.split(':');
  const safeVerb = prefix === REVERSE_CHANNEL_AUDIT_RESOURCE_PREFIX.slice(0, -1) ? (verb ?? '') : `${prefix}:${verb ?? ''}`;
  const decoded: DecodedAuditResource = { verb: safeVerb, targetId };
  for (const item of rest) {
    if (item.startsWith('sender=')) decoded.sender = item.slice('sender='.length);
    if (item.startsWith('sig=')) decoded.sig = item.slice('sig='.length);
    if (item.startsWith('result=')) decoded.result = item.slice('result='.length);
  }
  return decoded;
}
