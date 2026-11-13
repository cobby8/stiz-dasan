/**
 * 학부모의 청구서 요청(입금 확인·영수증) 규칙.
 *
 * 실제 운영(2026-08-09 확인): 수강료는 랠리즈·계좌이체·현장 카드로 받고,
 * 시스템에는 결과만 기록한다. 그래서 학부모가 입금해도 화면은 한동안 "미납"이라
 * "입금했는데요" 문자가 온다. 영수증도 요청이 올 때만 발급한다.
 *
 * 화면·서버가 각자 판단하면 "화면에선 되는데 저장이 안 되는" 어긋남이 생긴다.
 */

export const PAYMENT_REQUEST_KINDS = ["PAYMENT_CLAIM", "RECEIPT"] as const;
export type PaymentRequestKind = (typeof PAYMENT_REQUEST_KINDS)[number];

export const PAYMENT_REQUEST_KIND_LABEL: Record<PaymentRequestKind, string> = {
  PAYMENT_CLAIM: "입금 확인 요청",
  RECEIPT: "영수증 요청",
};

/**
 * 학부모가 고를 수 있는 결제 수단. 실제로 쓰는 것만 둔다.
 * 2026-11-14 랠리즈 은퇴 2단계: «랠리즈»는 새로 고를 수 없다(화면 버튼·서버 검사가 이 목록 하나를 쓴다).
 */
export const PAYMENT_METHODS = ["TRANSFER", "CARD", "CASH"] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHODS)[number];

/** 표시 이름. RALLYZ 는 고를 수는 없지만 과거 요청을 «랠리즈»로 보여 주려고 남긴다. */
export const PAYMENT_METHOD_LABEL: Record<PaymentMethodKind | "RALLYZ", string> = {
  TRANSFER: "계좌이체",
  RALLYZ: "랠리즈",
  CARD: "카드",
  CASH: "현금",
};

export const RECEIPT_TYPES = ["CASH_RECEIPT", "EXPENSE_PROOF"] as const;
export type ReceiptType = (typeof RECEIPT_TYPES)[number];

export const RECEIPT_TYPE_LABEL: Record<ReceiptType, string> = {
  CASH_RECEIPT: "현금영수증(소득공제)",
  EXPENSE_PROOF: "지출증빙(사업자)",
};

export const PAYMENT_REQUEST_STATUS_LABEL: Record<string, string> = {
  PENDING: "확인 중",
  DONE: "처리 완료",
  REJECTED: "확인 안 됨",
  CANCELED: "취소함",
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function isYmd(value: unknown): value is string {
  if (typeof value !== "string" || !YMD.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** 청구서가 아직 안 낸 상태인지. 이 상태에서만 "입금했어요"가 말이 된다. */
export function isUnpaidStatus(status: string): boolean {
  return status === "PENDING" || status === "OVERDUE";
}

export type PaymentRequestError =
  | "INVALID_KIND"
  | "ALREADY_PAID"
  | "NOT_PAID_YET"
  | "METHOD_REQUIRED"
  | "PAID_DATE_REQUIRED"
  | "PAID_DATE_IN_FUTURE"
  | "RECEIPT_TYPE_REQUIRED"
  | "RECEIPT_TARGET_REQUIRED"
  | "NOTE_TOO_LONG";

export const PAYMENT_REQUEST_MESSAGE: Record<PaymentRequestError, string> = {
  INVALID_KIND: "요청 종류를 다시 선택해 주세요.",
  ALREADY_PAID: "이미 납부 처리된 청구서입니다.",
  NOT_PAID_YET: "납부가 확인된 청구서만 영수증을 요청할 수 있습니다.",
  METHOD_REQUIRED: "어떻게 결제하셨는지 선택해 주세요.",
  PAID_DATE_REQUIRED: "입금하신 날짜를 선택해 주세요.",
  PAID_DATE_IN_FUTURE: "입금일은 오늘까지만 선택할 수 있습니다.",
  RECEIPT_TYPE_REQUIRED: "영수증 종류를 선택해 주세요.",
  RECEIPT_TARGET_REQUIRED: "현금영수증은 휴대폰 번호, 지출증빙은 사업자번호가 필요합니다.",
  NOTE_TOO_LONG: "남기실 말씀은 500자 이내로 적어 주세요.",
};

export type PaymentRequestInput = {
  kind?: unknown;
  paidOn?: unknown;
  method?: unknown;
  depositorName?: unknown;
  receiptType?: unknown;
  receiptTarget?: unknown;
  note?: unknown;
};

export function validatePaymentRequest(
  input: PaymentRequestInput,
  context: { paymentStatus: string; today: string },
): { ok: true; kind: PaymentRequestKind } | { ok: false; error: PaymentRequestError } {
  if (typeof input.kind !== "string" || !(PAYMENT_REQUEST_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, error: "INVALID_KIND" };
  }
  const kind = input.kind as PaymentRequestKind;

  if (typeof input.note === "string" && input.note.length > 500) {
    return { ok: false, error: "NOTE_TOO_LONG" };
  }

  if (kind === "PAYMENT_CLAIM") {
    // 이미 납부 처리된 건에 또 확인 요청이 오면 원장이 같은 일을 두 번 한다.
    if (!isUnpaidStatus(context.paymentStatus)) return { ok: false, error: "ALREADY_PAID" };
    if (typeof input.method !== "string" || !(PAYMENT_METHODS as readonly string[]).includes(input.method)) {
      return { ok: false, error: "METHOD_REQUIRED" };
    }
    if (!isYmd(input.paidOn)) return { ok: false, error: "PAID_DATE_REQUIRED" };
    // 미래 입금은 없다. 통장에서 대조할 수 없는 날짜를 받으면 확인이 불가능하다.
    if (input.paidOn > context.today) return { ok: false, error: "PAID_DATE_IN_FUTURE" };
    return { ok: true, kind };
  }

  // 영수증은 실제로 받은 돈에 대해서만 발급한다.
  if (context.paymentStatus !== "PAID") return { ok: false, error: "NOT_PAID_YET" };
  if (typeof input.receiptType !== "string" || !(RECEIPT_TYPES as readonly string[]).includes(input.receiptType)) {
    return { ok: false, error: "RECEIPT_TYPE_REQUIRED" };
  }
  // 번호가 없으면 원장이 발급을 못 한다. 받아둔 뒤 다시 물어보게 만들지 않는다.
  if (typeof input.receiptTarget !== "string" || input.receiptTarget.replace(/\D/g, "").length < 8) {
    return { ok: false, error: "RECEIPT_TARGET_REQUIRED" };
  }
  return { ok: true, kind };
}
