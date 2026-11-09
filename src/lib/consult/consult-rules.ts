/**
 * 상담 신청 — 순수 규칙 한 곳 (2026-11-10 원장 승인 k1·m4)
 *
 * «학생 인적 사항·희망 수업·요청사항을 입력하면 관리자가 확인 후 유선 연락하는 기능».
 * 접수 경로 3곳(홈페이지·챗봇·학부모 앱)과 관리자 처리(신청함 «상담» 탭)가 같은 규칙을 쓰도록 여기 모은다.
 *
 * ⚠️ 순수 모듈이다 — DB·React·next 를 부르지 않는다(node 테스트가 바로 import 한다).
 * ⚠️ CONSULT_STATUSES / CONSULT_SOURCES 는 마이그레이션 20261110160000_consult_request 의 CHECK 와 같은 집합이어야 한다
 *    (tests/consult-request.test.mjs 가 비교 — 한쪽만 바꾸면 DB 가 저장을 통째로 거부한다).
 */

// ── 상태·경로 ────────────────────────────────────────────────────────────

export const CONSULT_STATUSES = ["NEW", "CONTACTED", "DONE", "CANCELED"] as const;
export type ConsultStatus = (typeof CONSULT_STATUSES)[number];

export const CONSULT_SOURCES = ["PUBLIC_WEB", "CHATBOT", "PARENT_APP"] as const;
export type ConsultSource = (typeof CONSULT_SOURCES)[number];

export const CONSULT_SOURCE_LABEL: Record<ConsultSource, string> = {
  PUBLIC_WEB: "홈페이지",
  CHATBOT: "챗봇",
  PARENT_APP: "학부모 앱",
};

/**
 * 신청함 칸 지도 — catalog.ts 에 «CONSULT» 종류를 넣을 때 이 값을 그대로 옮긴다.
 *   NEW = 처리 필요(원장이 전화해야 한다) · CONTACTED = 진행 중(통화했고 결과 대기) · DONE/CANCELED = 완료
 * tone 은 statusTones 의 색 뜻 이름(warning·info·success·neutral)과 같다.
 */
export const CONSULT_STATUS_MAP: Record<ConsultStatus, { bucket: "ACTION" | "ONGOING" | "DONE"; label: string; tone: "warning" | "info" | "success" | "neutral" }> = {
  NEW: { bucket: "ACTION", label: "새 상담", tone: "warning" },
  CONTACTED: { bucket: "ONGOING", label: "연락함", tone: "info" },
  DONE: { bucket: "DONE", label: "상담 완료", tone: "success" },
  CANCELED: { bucket: "DONE", label: "취소", tone: "neutral" },
};

export function isConsultStatus(value: unknown): value is ConsultStatus {
  return typeof value === "string" && (CONSULT_STATUSES as readonly string[]).includes(value);
}

export function isConsultSource(value: unknown): value is ConsultSource {
  return typeof value === "string" && (CONSULT_SOURCES as readonly string[]).includes(value);
}

/** 칸(처리 필요/진행 중/완료)에 들어가는 상태 목록 */
export function consultStatusesOf(bucket: "ACTION" | "ONGOING" | "DONE"): ConsultStatus[] {
  return CONSULT_STATUSES.filter((s) => CONSULT_STATUS_MAP[s].bucket === bucket);
}

// ── 관리자 처리(상태 바꾸기) ─────────────────────────────────────────────

/** 관리자 버튼 — 연락함 · 완료 · 취소 · 메모만 저장 */
export const CONSULT_ACTIONS = ["CONTACTED", "DONE", "CANCELED", "NOTE"] as const;
export type ConsultAction = (typeof CONSULT_ACTIONS)[number];

export function isConsultAction(value: unknown): value is ConsultAction {
  return typeof value === "string" && (CONSULT_ACTIONS as readonly string[]).includes(value);
}

/**
 * 버튼마다 «어느 상태에서 누를 수 있나 → 어느 상태가 되나».
 * 완료·취소는 끝난 상태라 다시 바꾸지 않는다(메모는 언제든 남길 수 있다).
 */
export const CONSULT_TRANSITIONS: Record<ConsultAction, { from: readonly ConsultStatus[]; to: ConsultStatus | null }> = {
  CONTACTED: { from: ["NEW"], to: "CONTACTED" },
  DONE: { from: ["NEW", "CONTACTED"], to: "DONE" },
  CANCELED: { from: ["NEW", "CONTACTED"], to: "CANCELED" },
  NOTE: { from: CONSULT_STATUSES, to: null }, // 상태는 그대로, 메모만
};

/** 지금 상태에서 누를 수 있는 버튼 — 신청함 상세 칸이 버튼을 보일지 정할 때 쓴다 */
export function consultActionsFor(status: string): ConsultAction[] {
  return CONSULT_ACTIONS.filter((a) => (CONSULT_TRANSITIONS[a].from as readonly string[]).includes(status));
}

// ── 입력 정리·검증 ───────────────────────────────────────────────────────

/** 학년/나이 고르기 — 체험 신청 목록에 유아 5세를 더했다(유아반 5~7세) */
export const CONSULT_GRADE_OPTIONS = ["5세", "6세", "7세", "초1", "초2", "초3", "초4", "초5", "초6", "중1", "중2", "중3", "고1", "고2", "고3", "성인"] as const;
export const CONSULT_DAY_OPTIONS = ["월", "화", "수", "목", "금", "토", "일"] as const;
export const CONSULT_TIME_OPTIONS = ["평일 오후(방과 후)", "평일 저녁", "주말 오전", "주말 오후", "시간 무관"] as const;

export const CONSULT_LIMITS = { studentName: 40, guardianName: 40, message: 1000, adminNote: 1000 } as const;

/** 공백 정리 + 길이 자르기(줄바꿈은 요청사항에서만 살린다) */
export function cleanConsultText(value: unknown, max: number, keepLines = false): string {
  const raw = value == null ? "" : String(value);
  const cleaned = keepLines
    ? raw.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim()
    : raw.replace(/\s+/g, " ").trim();
  return cleaned.slice(0, max);
}

/** 휴대폰 번호 → 숫자만(010…). 형식이 아니면 빈 문자열 */
export function normalizeConsultPhone(value: unknown): string {
  const digits = (value == null ? "" : String(value)).replace(/\D/g, "");
  return /^01[016789]\d{7,8}$/.test(digits) ? digits : "";
}

/** 화면 표시용 010-1234-5678 */
export function formatConsultPhone(digits: string): string {
  const d = digits.replace(/\D/g, "");
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return d;
}

/** 여러 개 고르기 값 → 허용 목록에 있는 것만, 목록 순서대로, «·»로 이어 붙인 글자(없으면 null) */
function pickJoined(values: unknown, allowed: readonly string[]): string | null {
  const list = Array.isArray(values) ? values.map((v) => String(v)) : [];
  const picked = allowed.filter((option) => list.includes(option));
  return picked.length ? picked.join("·") : null;
}

export type ConsultInput = {
  studentName?: unknown;
  grade?: unknown;
  guardianName?: unknown;
  guardianPhone?: unknown;
  preferredDays?: unknown; // 문자열 배열(월~일)
  preferredTimes?: unknown; // 문자열 배열(CONSULT_TIME_OPTIONS)
  message?: unknown;
  privacyConsent?: unknown; // true 여야 받는다
};

export type CleanConsultInput = {
  studentName: string;
  grade: string;
  guardianName: string | null;
  guardianPhone: string; // 숫자만
  preferredDays: string | null;
  preferredTimes: string | null;
  message: string | null;
};

/**
 * 화면 값을 믿지 않고 서버에서 다시 정리·검증한다.
 * 필수: 학생 이름·학년·보호자 연락처·개인정보 동의. 나머지는 선택(최소 수집).
 */
export function validateConsultInput(input: ConsultInput | null | undefined): { ok: true; value: CleanConsultInput } | { ok: false; message: string } {
  const data = input ?? {};
  const studentName = cleanConsultText(data.studentName, CONSULT_LIMITS.studentName);
  const grade = cleanConsultText(data.grade, 20);
  const guardianName = cleanConsultText(data.guardianName, CONSULT_LIMITS.guardianName) || null;
  const guardianPhone = normalizeConsultPhone(data.guardianPhone);
  const message = cleanConsultText(data.message, CONSULT_LIMITS.message, true) || null;

  if (!studentName) return { ok: false, message: "학생 이름을 입력해 주세요." };
  if (!(CONSULT_GRADE_OPTIONS as readonly string[]).includes(grade)) return { ok: false, message: "학년(나이)을 골라 주세요." };
  if (!guardianPhone) return { ok: false, message: "연락받을 휴대폰 번호를 정확히 입력해 주세요. 예: 010-1234-5678" };
  if (data.privacyConsent !== true) return { ok: false, message: "개인정보 수집·이용에 동의해 주세요. 동의하지 않으면 상담 신청을 할 수 없어요." };

  return {
    ok: true,
    value: {
      studentName,
      grade,
      guardianName,
      guardianPhone,
      preferredDays: pickJoined(data.preferredDays, CONSULT_DAY_OPTIONS),
      preferredTimes: pickJoined(data.preferredTimes, CONSULT_TIME_OPTIONS),
      message,
    },
  };
}

/**
 * 공개 접수 경로 — 화면이 보낸 경로 값 중 «PUBLIC_WEB/CHATBOT»만 받는다.
 * PARENT_APP 은 로그인 학부모 액션만 쓸 수 있다(공개 화면이 앱 신청인 척 못 하게).
 */
export function publicConsultSource(value: unknown): ConsultSource {
  return value === "CHATBOT" ? "CHATBOT" : "PUBLIC_WEB";
}

/** 남용 방지 한도 — 체육관 대관과 같은 숫자(연락처·접속 주소·전체) */
export const CONSULT_RATE_LIMIT = { perPhone10Min: 3, perPhoneDay: 6, perIp10Min: 5, perIpDay: 15, global10Min: 30 } as const;

export type ConsultRateCounts = { phone10: number; phoneDay: number; ip10: number; ipDay: number; all10: number };

export function isConsultRateLimited(c: Partial<ConsultRateCounts> | null | undefined): boolean {
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return n(c?.phone10) >= CONSULT_RATE_LIMIT.perPhone10Min
    || n(c?.phoneDay) >= CONSULT_RATE_LIMIT.perPhoneDay
    || n(c?.ip10) >= CONSULT_RATE_LIMIT.perIp10Min
    || n(c?.ipDay) >= CONSULT_RATE_LIMIT.perIpDay
    || n(c?.all10) >= CONSULT_RATE_LIMIT.global10Min;
}

// ── 관리자 알림 글 ───────────────────────────────────────────────────────

/** 관리자 벨·웹푸시 본문 — 연락처는 넣지 않는다(잠금 화면에 번호가 뜨지 않게) */
export function consultAdminAlertText(row: Pick<CleanConsultInput, "studentName" | "grade" | "preferredDays" | "preferredTimes">, source: ConsultSource): string {
  const wish = [row.preferredDays, row.preferredTimes].filter(Boolean).join(" ");
  return [`${row.studentName} (${row.grade})`, wish ? `희망 ${wish}` : "", CONSULT_SOURCE_LABEL[source]].filter(Boolean).join(" · ");
}
