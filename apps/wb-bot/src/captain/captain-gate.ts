export interface CaptainGateInputs {
  mode: 'single' | 'multi-bot';
  botId: string;
  disableCaptainEnv?: string;
}

export function isCaptainEnabled(inputs: CaptainGateInputs): boolean {
  if (inputs.mode !== 'multi-bot') return false;
  if (inputs.botId !== 'default') return false;
  if (inputs.disableCaptainEnv === 'true' || inputs.disableCaptainEnv === '1') return false;
  return true;
}
