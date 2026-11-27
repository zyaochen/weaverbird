const LARK_CREDENTIAL_PLACEHOLDERS = {
  LARK_APP_ID: new Set(['your_lark_app_id_here']),
  LARK_APP_SECRET: new Set(['your_lark_app_secret_here']),
} as const;

type LarkCredentialKey = keyof typeof LARK_CREDENTIAL_PLACEHOLDERS;

function assertNotPlaceholder(
  key: LarkCredentialKey,
  value: string,
  sourceLabel: string,
): void {
  const trimmed = value.trim();
  if (!LARK_CREDENTIAL_PLACEHOLDERS[key].has(trimmed)) return;
  throw new Error(
    `${key} in ${sourceLabel} still uses the shipped placeholder; replace it with a real Feishu app credential before starting wb-bot`,
  );
}

export function assertNoPlaceholderLarkCredentials(input: {
  appId: string;
  appSecret: string;
  sourceLabel: string;
}): void {
  assertNotPlaceholder('LARK_APP_ID', input.appId, input.sourceLabel);
  assertNotPlaceholder('LARK_APP_SECRET', input.appSecret, input.sourceLabel);
}
