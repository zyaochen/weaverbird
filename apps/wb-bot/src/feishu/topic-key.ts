export type NormalizeTopicInput = {
  chatId?: string | null;
  rootId?: string | null;
  messageId?: string | null;
  chatType?: string | null;
};

function readToken(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toChatTopicKey(chatId: string | null | undefined): string | null {
  const value = readToken(chatId);
  if (!value) return null;
  return value.startsWith('chat:') ? value : `chat:${value}`;
}

export function toRootTopicKey(rootId: string | null | undefined): string | null {
  const value = readToken(rootId);
  if (!value) return null;
  return value.startsWith('root:') ? value : `root:${value}`;
}

export function normalizeTopic(input: NormalizeTopicInput): string {
  const rootKey = toRootTopicKey(input.rootId);
  if (rootKey) return rootKey;

  const chatKey = toChatTopicKey(input.chatId);
  const messageToken = readToken(input.messageId);
  const groupLikeMessage = input.chatType != null && input.chatType !== 'p2p';
  if (groupLikeMessage && messageToken) {
    return messageToken.startsWith('root:') ? messageToken : `root:${messageToken}`;
  }

  if (chatKey) return chatKey;
  if (messageToken) return messageToken.startsWith('root:') ? messageToken : `root:${messageToken}`;
  return 'chat:';
}
