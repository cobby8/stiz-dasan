import { normalizeMessagePhone } from "@/lib/message-ledger";

export const MANUAL_MESSAGE_RECIPIENT_LIMIT = 100;
export const BULK_MANUAL_MESSAGE_RECIPIENT_LIMIT = 500;
const MANUAL_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function validateManualMessageRequestId(requestId: string | undefined) {
  const value = requestId?.trim();
  if (!value) return null;
  if (!MANUAL_REQUEST_ID_PATTERN.test(value)) {
    throw new Error("올바르지 않은 문자 발송 요청 ID입니다.");
  }
  return value;
}

export type ManualMessageRecipientResult = {
  recipient: string;
  last4: string;
  ok: boolean;
  status: "SENT" | "FAILED" | "UNCERTAIN" | "ALREADY_PROCESSED";
  uncertain?: boolean;
  reason?: string;
  provider?: string;
  providerMessageId?: string;
  providerGroupId?: string;
  messageType?: "SMS" | "LMS";
};

export type ManualMessageSendResult = {
  batchId: string;
  total: number;
  success: number;
  failed: number;
  uncertain: number;
  duplicateCount: number;
  invalidCount: number;
  results: ManualMessageRecipientResult[];
  retryRecipients: string[];
};

export type ManualMessageBatchStatus = {
  batchId: string;
  status: string;
  total: number;
  pending: number;
  processing: number;
  success: number;
  failed: number;
  uncertain: number;
  recipients: Array<{ id: string; recipient: string; status: string; reason?: string | null }>;
};

/**
 * 같은 번호가 하이픈 유무만 다르게 입력되어도 한 명으로 취급합니다.
 * 순서는 관리자가 선택한 최초 순서를 그대로 유지합니다.
 */
export function normalizeUniqueManualRecipients(recipients: string[]) {
  const unique = new Map<string, string>();
  let invalidCount = 0;

  for (const rawPhone of recipients) {
    const normalized = normalizeMessagePhone(rawPhone);
    if (normalized.length < 10 || normalized.length > 11) {
      invalidCount += 1;
      continue;
    }
    if (!unique.has(normalized)) unique.set(normalized, normalized);
  }

  return {
    recipients: [...unique.values()],
    duplicateCount: recipients.length - invalidCount - unique.size,
    invalidCount,
  };
}
