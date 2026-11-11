/**
 * 수강 변경 신청(반 변경·휴원·퇴원)의 규칙.
 *
 * 화면·서버·관리자 승인이 같은 규칙을 봐야 한다. 세 곳에 각자 적으면
 * "화면에서는 되는데 저장이 안 되는" 어긋남이 생긴다. 그래서 순수 함수로 모은다.
 */

export const CHANGE_KINDS = ["CLASS_CHANGE", "PAUSE", "WITHDRAW"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export const MAX_PAUSE_CLASSES_PER_REQUEST = 20;

export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = {
  CLASS_CHANGE: "반·요일 변경",
  PAUSE: "휴원",
  WITHDRAW: "퇴원",
};

/**
 * 복귀(RESUME) — 휴원 중(PAUSED)인 반에만 내는 신청이다.
 * 다니는 반에서 고르는 세 종류(CHANGE_KINDS)와 출발 상태가 달라 따로 둔다.
 * (CHANGE_KINDS 에 넣으면 다니는 반 화면의 종류 버튼에도 «복귀»가 생긴다.)
 */
export const RESUME_KIND = "RESUME" as const;

/** 학부모 화면·원장 알림에 쓰는 종류 이름. 복귀까지 포함한다. */
export const REQUEST_KIND_LABEL: Record<string, string> = { ...CHANGE_KIND_LABEL, [RESUME_KIND]: "복귀" };

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

/** 복귀일을 아직 정하지 않은 휴원도 날짜가 누락된 신청과 혼동하지 않게 표시한다. */
export function pauseResumeLabel(resumeOn: string | null | undefined): string {
  return isYmd(resumeOn) ? `${resumeOn} 복귀 예정` : "복귀일 미정";
}

/** 휴원 당일을 복귀일로 고를 수 없도록 날짜 입력의 최소값도 서버 규칙과 맞춘다. */
export function earliestResumeOn(effectiveFrom: string): string {
  if (!isYmd(effectiveFrom)) return "";
  const [year, month, day] = effectiveFrom.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
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

const DOW_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** "YYYY-MM-DD" 의 다음 날. 달력 숫자만 센다(시간대 개입 없음 — 이 파일은 import 없이 단독 실행된다). */
function nextDayYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 휴원 시작일로 고를 수 있는 가장 이른 날(원장 결정 2026-11-10 m7·k10).
 * «오늘부터 — 오늘 그 반 수업 시작 전이면 오늘 포함, 이미 시작했으면 내일부터».
 * - 오늘이 그 반 요일이 아니면 오늘(오늘 빠지는 수업이 없다).
 * - 오늘이 그 반 요일이고 지금(KST "HH:MM")이 수업 시작 전이면 오늘.
 * - 그 밖(이미 시작·반 요일/시각을 모름)은 내일 — 모르면 안전한 쪽(이미 들은 수업을 휴원으로 빼지 않게).
 * today·nowHm 은 부르는 쪽이 공용 KST 모듈(todayKst·kstHm)로 구해 넘긴다.
 */
export function earliestPauseStart(input: {
  today: string;
  nowHm: string;
  classDayOfWeek?: string | null;
  classStartTime?: string | null;
}): string {
  if (!isYmd(input.today)) throw new Error("INVALID_DATE");
  const tomorrow = nextDayYmd(input.today);
  const classDow = DOW_INDEX[String(input.classDayOfWeek ?? "")];
  if (classDow === undefined) return tomorrow;
  const [y, m, d] = input.today.split("-").map(Number);
  const todayDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (classDow !== todayDow) return input.today;
  const start = /^(\d{1,2}):(\d{2})/.exec(String(input.classStartTime ?? ""));
  const now = /^(\d{1,2}):(\d{2})/.exec(String(input.nowHm ?? ""));
  if (!start || !now) return tomorrow;
  const startMin = Number(start[1]) * 60 + Number(start[2]);
  const nowMin = Number(now[1]) * 60 + Number(now[2]);
  return nowMin < startMin ? input.today : tomorrow;
}

/**
 * 적용 시작일을 정한다.
 *
 * 반 변경·휴원은 학부모가 날짜를 고를 수 있다(반 변경 = 원장 지시, 휴원 = 2026-11-10 원장 결정 k10·m7
 * «갑작스러운 휴원도 있으니 언제든 신청 — 오늘부터(오늘 수업 전이면 오늘 포함)»).
 * 퇴원은 다음 달 1일로 고정한다. 휴원 날짜를 보내지 않은 옛 화면은 예전처럼 다음 달 1일.
 * 고른 날짜가 규칙을 벗어나면 조용히 바꾸지 않고 거절한다. 조용히 바꾸면 학부모가
 * 신청한 날과 실제 적용일이 달라진다.
 */
export function resolveEffectiveFrom(input: {
  kind: ChangeKind;
  requestedFrom?: unknown;
  today: string;
  /** 휴원일 때 고를 수 있는 가장 이른 날(earliestPauseStart). 없으면 내일. */
  earliestPauseFrom?: string | null;
}): { ok: true; effectiveFrom: string } | { ok: false; error: ChangeRequestError } {
  if (input.kind === "PAUSE") {
    const requested = typeof input.requestedFrom === "string" ? input.requestedFrom.trim() : "";
    if (!requested) return { ok: true, effectiveFrom: nextMonthStart(input.today) };
    if (!isYmd(requested)) return { ok: false, error: "INVALID_EFFECTIVE_DATE" };
    const earliest = input.earliestPauseFrom && isYmd(input.earliestPauseFrom) ? input.earliestPauseFrom : nextDayYmd(input.today);
    // "YYYY-MM-DD" 는 글자 순서 = 날짜 순서
    if (requested < earliest) return { ok: false, error: "PAUSE_START_TOO_SOON" };
    if (requested > addMonths(input.today, MAX_EFFECTIVE_MONTHS_AHEAD)) return { ok: false, error: "EFFECTIVE_DATE_TOO_FAR" };
    return { ok: true, effectiveFrom: requested };
  }
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
  | "EFFECTIVE_DATE_TOO_FAR"
  | "RESUME_DATE_REQUIRED"
  | "RESUME_DATE_PAST"
  | "RESUME_DATE_TOO_FAR"
  | "PAUSE_START_TOO_SOON";

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
  RESUME_DATE_REQUIRED: "복귀 희망일을 골라 주세요.",
  RESUME_DATE_PAST: "복귀 희망일은 오늘 이후로 골라 주세요.",
  RESUME_DATE_TOO_FAR: "복귀 희망일은 3개월 이내로 골라 주세요.",
  PAUSE_START_TOO_SOON: "휴원 시작일을 다시 골라 주세요. 오늘 수업이 이미 시작됐으면 내일부터 고를 수 있어요.",
};

/**
 * 복귀 신청의 복귀 희망일(= 다시 다니기 시작하는 날)을 검사한다.
 *
 * 오늘(KST)도 고를 수 있다 — 쉬던 아이가 «오늘부터» 나오는 일이 흔하다.
 * 지난날은 막는다(이미 지난 수업의 출석·청구가 꼬인다). 너무 먼 날은 반 사정을 알 수 없어 3개월로 묶는다.
 * 고른 날짜를 조용히 바꾸지 않고 거절한다(신청한 날과 실제 복귀일이 달라지면 안 된다).
 */
export function resolveResumeDate(input: { requested?: unknown; today: string }):
  { ok: true; resumeFrom: string } | { ok: false; error: ChangeRequestError } {
  const requested = typeof input.requested === "string" ? input.requested.trim() : "";
  if (!requested) return { ok: false, error: "RESUME_DATE_REQUIRED" };
  if (!isYmd(requested)) return { ok: false, error: "INVALID_RESUME_DATE" };
  // "YYYY-MM-DD" 는 글자 순서 = 날짜 순서라 문자열 비교로 충분하다.
  if (requested < input.today) return { ok: false, error: "RESUME_DATE_PAST" };
  if (requested > addMonths(input.today, MAX_EFFECTIVE_MONTHS_AHEAD)) return { ok: false, error: "RESUME_DATE_TOO_FAR" };
  return { ok: true, resumeFrom: requested };
}
