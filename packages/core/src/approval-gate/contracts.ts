export const APPROVAL_GATE_ANCHORS = {
  WRITE_TO_MAIN_BRANCH: 'writeToMainBranch',
  ENV_VAR_CHANGE: 'envVarChange',
  EXTERNAL_DEP_UPGRADE: 'externalDepUpgrade',
} as const;

export type ApprovalGateAnchor = typeof APPROVAL_GATE_ANCHORS[keyof typeof APPROVAL_GATE_ANCHORS];

export const APPROVAL_GATE_APPROVER_POLICY = {
  OWNER: 'owner',
  OWNER_AND_CODE_OWNER: 'owner_and_code_owner',
} as const;

export type ApprovalGateApproverPolicy = typeof APPROVAL_GATE_APPROVER_POLICY[keyof typeof APPROVAL_GATE_APPROVER_POLICY];

export const APPROVAL_GATE_TIMEOUT_MS = {
  writeToMainBranch: 10 * 60 * 1000,
  envVarChange: 30 * 60 * 1000,
  externalDepUpgrade: 60 * 60 * 1000,
} as const;

export type ApprovalGateMatch = {
  anchor: ApprovalGateAnchor;
  approverPolicy: ApprovalGateApproverPolicy;
  timeoutMs: number;
  toolName: string;
  toolInput: unknown;
  summary: string;
  resource: string;
};

export const APPROVAL_REQUEST_STATUS = {
  PENDING_DISPATCH: 'pending_dispatch',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  DENIED: 'denied',
  EXPIRED: 'expired',
  FAILED_CLOSED: 'failed_closed',
} as const;

export type ApprovalRequestStatus = typeof APPROVAL_REQUEST_STATUS[keyof typeof APPROVAL_REQUEST_STATUS];

export const APPROVAL_CARRIER = {
  APPROVAL_APP: 'approval_app',
  GROUP_CARD: 'group_card',
} as const;

export type ApprovalCarrier = typeof APPROVAL_CARRIER[keyof typeof APPROVAL_CARRIER];

export type ApprovalRequestRecord = {
  requestId: string;
  runId: string;
  botId: string;
  sessionId: string;
  userOpenId: string;
  threadId: string;
  sourceMessageId: string;
  replyMessageId: string;
  agentId: string;
  cwd: string;
  createdAt: string;
  deadlineAt: string;
  status: ApprovalRequestStatus;
  anchor: ApprovalGateAnchor;
  approverPolicy: ApprovalGateApproverPolicy;
  timeoutMs: number;
  toolName: string;
  toolInput: unknown;
  resource: string;
  summary: string;
  allowedApproverOpenIds: string[];
  carrier?: ApprovalCarrier;
  carrierMessageId?: string;
  resolutionReason?: string;
  resolvedAt?: string;
  resolvedBy?: string;
};

export type ApprovalResolutionRecord = {
  requestId: string;
  runId: string;
  status: Extract<ApprovalRequestStatus, 'approved' | 'denied' | 'expired' | 'failed_closed'>;
  reason: string;
  resolvedAt: string;
  resolvedBy?: string;
};

export type ApprovalMirrorEntry = {
  ts: string;
  op: 'request_created' | 'request_dispatched' | 'request_resolved';
  request: ApprovalRequestRecord;
};
