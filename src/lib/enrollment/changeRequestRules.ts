/**
 * 수강 변경 신청(반 변경·휴원·퇴원)의 규칙.
 *
 * 화면·서버·관리자 승인이 같은 규칙을 봐야 한다. 세 곳에 각자 적으면
 * "화면에서는 되는데 저장이 안 되는" 어긋남이 생긴다. 그래서 순수 함수로 모은다.
 */

export const CHANGE_KINDS = ["CLASS_CHANGE", "PAUSE", "WITHDRAW"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = {
  CLASS_CHANGE: "반·요일 변경",
  PAUSE: "휴원",
  WITHDRAW: "퇴원",
};

export const CHANGE_STATUS_LABEL: Record<string, string> = {
  PENDING: "검토 중",
  APPROVED: "승인됨",
  REJECTED: "거절됨",
  CANCELED: "취소함",
  // 사이트 수강 상태까지 반영된 건(관리자 즉시 변경 · 적용일 자동 적용). 시트·랠리즈 확인은 운영 동기화에서 이어진다.
  APPLIED: "반영 완료",
};

/**
 * 사이트에 자동 적용된 휴원·퇴원의 시트·랠리즈 확인 상태 배지.
 * 랠리즈가 청구·수강의 원본이라, 사이트만 바뀐 채 "반영 완료"로 보이면 퇴원생에게 청구가 계속 나간다(2026-10-04 사고와 같은 종류).
 * 연결된 운영 원장이 없으면 null(배지 없음).
 */
export function syncCheckBadge(sheetStatus: string | null | undefined, rallyzStatus: string | null | undefined):
  { label: string; needsCheck: boolean } | null {
  if (!sheetStatus && !rallyzStatus) return null;
  // 시트 은퇴(2026-10~)로 건너뛴 SKIPPED 도 시트 확인 완료로 본다 → "랠리즈 확인 필요" / "반영 완료" 만 남는다.
  // (이 파일은 테스트가 단독으로 불러오므로 import 없이 적는다. 공용 isSheetTargetDone 과 같은 규칙인지 tests/sheet-retirement.test.mjs 가 대조한다.)
  const sheetDone = sheetStatus === "SUCCEEDED" || sheetStatus === "SKIPPED";
  const rallyzDone = rallyzStatus === "SUCCEEDED";
  if (sheetDone && rallyzDone) return { label: "반영 완료", needsCheck: false };
  if (!sheetDone && !rallyzDone) return { label: "사이트 반영됨 · 시트·랠리즈 확인 필요", needsCheck: true };
  if (!rallyzDone) return { label: "사이트 반영됨 · 랠리즈 확인 필요", needsCheck: true };
  return { label: "사이트 반영됨 · 시트 확인 필요", needsCheck: true };
}

export function isChangeKind(value: unknown): value is ChangeKind {
  return typeof value === "string" && (CHANGE_KINDS as readonly string[]).includes(value);
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function isYmd(value: unknown): value is string {
  if (typeof value !== "string" || !YMD.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // 2월 30일 같은 값을 막는다. UTC 로 만들어 시간대에 흔들리지 않게 한다.
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * 적용 시작일 = 다음 달 1일.
 *
 * 원장 결정: 월 단위로 청구하므로 달 중간에 반을 옮기면 그달 요금을 손으로 맞춰야 한다.
 * 신청 화면에도 이 날짜를 그대로 보여줘 "언제부터인지"를 학부모가 알고 신청하게 한다.
 */
export function nextMonthStart(todayYmd: string): string {
  if (!isYmd(todayYmd)) throw new Error("INVALID_DATE");
  const [y, m] = todayYmd.split("-").map(Number);
  const year = m === 12 ? y + 1 : y;
  const month = m === 12 ? 1 : m + 1;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

/** 학부모가 시작일을 고를 수 있는 범위(오늘 기준). 너무 먼 날짜는 반 편성을 예측할 수 없다. */
export const MAX_EFFECTIVE_MONTHS_AHEAD = 3;

export function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay); // 1/31 + 1개월 = 2/28 로 접는다
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * 적용 시작일을 정한다.
 *
 * 반 변경만 학부모가 날짜를 고를 수 있다(원장 지시). 휴원·퇴원은 다음 달 1일로 고정한다 —
 * 달 중간에 멈추면 그달 요금을 어디까지 받을지 매번 판단해야 한다.
 * 고른 날짜가 규칙을 벗어나면 조용히 바꾸지 않고 거절한다. 조용히 바꾸면 학부모가
 * 신청한 날과 실제 적용일이 달라진다.
 */
export function resolveEffectiveFrom(input: {
  kind: ChangeKind;
  requestedFrom?: unknown;
  today: string;
}): { ok: true; effectiveFrom: string } | { ok: false; error: ChangeRequestError } {
  if (input.kind !== "CLASS_CHANGE") return { ok: true, effectiveFrom: nextMonthStart(input.today) };

  const requested = typeof input.requestedFrom === "string" ? input.requestedFrom.trim() : "";
  if (!requested) return { ok: true, effectiveFrom: nextMonthStart(input.today) };
  if (!isYmd(requested)) return { ok: false, error: "INVALID_EFFECTIVE_DATE" };
  // 오늘·지난날은 막는다. 오늘 수업이 이미 끝났을 수 있어 어느 반 소속인지 애매해진다.
  if (requested <= input.today) return { ok: false, error: "EFFECTIVE_DATE_TOO_SOON" };
  if (requested > addMonths(input.today, MAX_EFFECTIVE_MONTHS_AHEAD)) {
    return { ok: false, error: "EFFECTIVE_DATE_TOO_FAR" };
  }
  return { ok: true, effectiveFrom: requested };
}

export type ChangeRequestInput = {
  // 전부 unknown·선택으로 받는다. 클라이언트가 보낸 값이라 모양을 믿을 수 없다.
  kind?: unknown;
  toClassId?: unknown;
  resumeOn?: unknown;
  reason?: unknown;
};

export type ChangeRequestError =
  | "INVALID_KIND"
  | "TO_CLASS_REQUIRED"
  | "TO_CLASS_NOT_ALLOWED"
  | "SAME_CLASS"
  | "INVALID_RESUME_DATE"
  | "RESUME_BEFORE_START"
  | "REASON_TOO_LONG"
  | "INVALID_EFFECTIVE_DATE"
  | "EFFECTIVE_DATE_TOO_SOON"
  | "EFFECTIVE_DATE_TOO_FAR";

/**
 * 신청 내용이 종류에 맞는지 본다. 소유권·정원은 여기서 보지 않는다(DB 를 봐야 한다).
 * effectiveFrom 은 서버가 정한다 — 클라이언트가 보낸 날짜를 믿으면 이번 달로 앞당길 수 있다.
 */
export function validateChangeRequest(
  input: ChangeRequestInput,
  context: { currentClassId: string; effectiveFrom: string },
): { ok: true; kind: ChangeKind } | { ok: false; error: ChangeRequestError } {
  if (!isChangeKind(input.kind)) return { ok: false, error: "INVALID_KIND" };
  const kind = input.kind;

  if (typeof input.reason === "string" && input.reason.length > 500) {
    return { ok: false, error: "REASON_TOO_LONG" };
  }

  if (kind === "CLASS_CHANGE") {
    if (typeof input.toClassId !== "string" || !input.toClassId.trim()) {
      return { ok: false, error: "TO_CLASS_REQUIRED" };
    }
    // 지금 다니는 반을 그대로 고르면 아무것도 바뀌지 않는다. 원장이 헛일을 하게 된다.
    if (input.toClassId.trim() === context.currentClassId) return { ok: false, error: "SAME_CLASS" };
  } else if (input.toClassId) {
    // 휴원·퇴원에 희망 반이 붙어 오면 화면과 서버가 어긋난 것이다. 조용히 무시하지 않는다.
    return { ok: false, error: "TO_CLASS_NOT_ALLOWED" };
  }

  if (kind === "PAUSE" && input.resumeOn !== undefined && input.resumeOn !== null && input.resumeOn !== "") {
    if (!isYmd(input.resumeOn)) return { ok: false, error: "INVALID_RESUME_DATE" };
    // 복귀일이 시작일보다 빠르면 휴원 기간이 없다.
    if (input.resumeOn <= context.effectiveFrom) return { ok: false, error: "RESUME_BEFORE_START" };
  }

  return { ok: true, kind };
}

export const CHANGE_REQUEST_MESSAGE: Record<ChangeRequestError, string> = {
  INVALID_KIND: "변경 종류를 다시 선택해 주세요.",
  TO_CLASS_REQUIRED: "옮기고 싶은 반을 선택해 주세요.",
  TO_CLASS_NOT_ALLOWED: "휴원·퇴원은 반을 선택하지 않습니다.",
  SAME_CLASS: "지금 다니는 반과 같습니다. 다른 반을 선택해 주세요.",
  INVALID_RESUME_DATE: "복귀 예정일을 다시 확인해 주세요.",
  RESUME_BEFORE_START: "복귀 예정일은 휴원 시작일보다 뒤여야 합니다.",
  REASON_TOO_LONG: "사유는 500자 이내로 적어 주세요.",
  INVALID_EFFECTIVE_DATE: "변경 시작일을 다시 확인해 주세요.",
  EFFECTIVE_DATE_TOO_SOON: "변경 시작일은 내일 이후로 선택해 주세요.",
  EFFECTIVE_DATE_TOO_FAR: "변경 시작일은 3개월 이내로 선택해 주세요.",
};
