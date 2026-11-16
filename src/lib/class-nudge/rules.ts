// 수업 미처리 장치(2026-11-17) — 순수 판정 규칙.
//
// «이 수업(반 × 날짜)이 지금 어떤 상태인가»를 답하는 계산기다.
// 1단계 관리자 대시보드 «오늘 수업 처리 현황»이 쓰고, 2~3단계의 알림·앱 잠금·자동 종료도 같은 계산기에 묻는다.
//
// ⚠️ prisma·next import 금지(테스트가 이 파일을 그대로 실행한다).
// ⚠️ 시계를 읽지 않는다 — «지금»(nowMs)과 «오늘»(today)은 반드시 인자로 받는다.
//    안에서 Date.now() 를 읽으면 테스트가 실제 날짜에 기대게 되고, 캐시된 판정이 낡는다.
import { isKstYmd, kstAt, kstDow } from "@/lib/datetime/kst";
import { CLASS_DAY_KEYS } from "@/lib/staff/classSubstitute";

export type ClassDayKind = "REGULAR" | "SEASONAL";

/** 독촉 기준 시간(분). 숫자는 이 한 곳에서만 정한다 — 바꾸려면 여기만 고치거나 인자로 넘긴다. */
export type ClassDayThresholds = {
  /** 시작 시각 + 이만큼 지나도 시작을 안 눌렀으면 «미처리» */
  startGraceMin: number;
  /** 끝 시각 + 이만큼 지나도 종료를 안 눌렀으면 «미처리» */
  endGraceMin: number;
  /** 예정 시각 + 이만큼 지나면 원장·부원장 단계(2단계 알림이 쓴다) */
  escalateMin: number;
};
export const DEFAULT_THRESHOLDS: ClassDayThresholds = { startGraceMin: 10, endGraceMin: 10, escalateMin: 30 };

export type ClassDayInput = {
  kind: ClassDayKind;
  /** 수업 시작 절대 시각(ms). 모르면 null */
  startMs: number | null;
  /** 수업 끝 절대 시각(ms). 모르면 null */
  endMs: number | null;
  nowMs: number;
  /** 연간일정 휴무(정규만 true 가 될 수 있다) */
  holiday: boolean;
  /** «오늘 이 반 휴강» 표시가 있다 */
  cancelled: boolean;
  /** 수업 기록. status = PLANNED | IN_PROGRESS | COMPLETED, 기록이 없으면 null */
  session: { status: string } | null;
  /** 출결을 찍어야 하는 인원(정규 수강생 + 보강 온 아이 / 특강은 좌석) */
  rosterCount: number;
  /** 그중 출결이 없는 인원 */
  unmarkedCount: number;
};

export type ClassDayState =
  | "HOLIDAY"        // 휴무 — 대상 아님
  | "CANCELLED"      // 휴강 표시됨 — 대상 아님(독촉 멈춤)
  | "NO_STUDENTS"    // 출결 대상 0명 — 대상 아님
  | "UPCOMING"       // 시작 전
  | "NOT_STARTED"    // 시작 시각이 지났는데 시작을 안 눌렀다
  | "IN_PROGRESS"    // 진행 중(끝 시각 + 유예 전)
  | "OVERRUN"        // 진행 중인데 끝 시각 + 유예가 지났다
  | "RECORDED"       // 시작·종료 없이 출결만 모두 들어 있다(관리자 입력·랠리즈)
  | "COMPLETED"      // 종료됨
  | "TIME_UNKNOWN";  // 수업 시각을 몰라 판정 보류

export type ClassDayNudge = "NONE" | "DUE" | "ESCALATE";
export type ClassDayReason = "NOT_STARTED" | "UNMARKED" | "NOT_ENDED";

export type ClassDayStatus = {
  state: ClassDayState;
  /** 1단계: 화면의 «미처리» 판정 / 2단계: 알림 단계 */
  nudge: ClassDayNudge;
  /** 미처리 이유(없으면 빈 배열) */
  reasons: ClassDayReason[];
  /** 화면 표시용(완료인데 남은 경우도 그대로 싣는다) */
  unmarkedCount: number;
  /** nowMs >= startMs — 2단계 «앱 잠금» 기준(유예 없이 정각) */
  startPassed: boolean;
  /** nudge 가 DUE 가 되는(된) 시각 */
  dueAtMs: number | null;
  /** nudge 가 ESCALATE 가 되는(된) 시각 */
  escalateAtMs: number | null;
};

const MIN_MS = 60_000;

/** 숫자가 아니거나 음수면 0 — DB 에서 온 값이 이상해도 판정이 NaN 으로 무너지지 않게 */
function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function known(ms: number | null | undefined): ms is number {
  return typeof ms === "number" && Number.isFinite(ms);
}

/**
 * 수업 한 건의 상태 판정. 위에서부터 먼저 맞는 것이 답이다.
 * 경계는 모두 «이상(>=)» — 시작 정각이면 startPassed, +10분 정각이면 DUE.
 */
export function classDayStatus(input: ClassDayInput, t: ClassDayThresholds = DEFAULT_THRESHOLDS): ClassDayStatus {
  const nowMs = input.nowMs;
  const startMs = known(input.startMs) ? input.startMs : null;
  const endMs = known(input.endMs) ? input.endMs : null;
  const unmarkedCount = count(input.unmarkedCount);
  const rosterCount = count(input.rosterCount);
  const sessionStatus = input.session?.status ?? null;
  const startPassed = startMs !== null && nowMs >= startMs;
  const base = { unmarkedCount, startPassed, reasons: [] as ClassDayReason[], nudge: "NONE" as ClassDayNudge };
  const startDue = startMs === null ? null : startMs + t.startGraceMin * MIN_MS;
  const startEscalate = startMs === null ? null : startMs + t.escalateMin * MIN_MS;
  const endDue = endMs === null ? null : endMs + t.endGraceMin * MIN_MS;
  const endEscalate = endMs === null ? null : endMs + t.escalateMin * MIN_MS;

  // 1. 종료된 수업 — 남은 미확인은 화면에만 보인다(종료 뒤에 수강이 추가된 경우 등, 독촉 아님)
  if (sessionStatus === "COMPLETED") {
    return { ...base, state: "COMPLETED", dueAtMs: null, escalateAtMs: null };
  }

  // 2. 진행 중 — 휴무·휴강이어도 «실제 상태»가 이긴다(선생님이 실제로 수업 중)
  if (sessionStatus === "IN_PROGRESS") {
    // 끝 시각을 모르면 끝 판정만 보류한다
    if (endDue === null || endEscalate === null || nowMs < endDue) {
      return { ...base, state: "IN_PROGRESS", dueAtMs: endDue, escalateAtMs: endEscalate };
    }
    return {
      ...base,
      state: "OVERRUN",
      reasons: [unmarkedCount > 0 ? "UNMARKED" : "NOT_ENDED"],
      nudge: nowMs >= endEscalate ? "ESCALATE" : "DUE",
      dueAtMs: endDue,
      escalateAtMs: endEscalate,
    };
  }

  // 여기부터 기록이 없거나 PLANNED(미리 써 두기만 한 수업)
  const off = { ...base, dueAtMs: null, escalateAtMs: null };
  if (input.holiday) return { ...off, state: "HOLIDAY" };        // 3. 휴무가 휴강보다 먼저
  if (input.cancelled) return { ...off, state: "CANCELLED" };    // 4.
  if (rosterCount <= 0) return { ...off, state: "NO_STUDENTS" }; // 5.
  // 6. 출결이 모두 들어 있다 — 관리자가 대신 넣은 수업이라 선생님을 독촉하지 않는다(«완료»와는 구분)
  if (unmarkedCount === 0) return { ...off, state: "RECORDED" };
  // 7. 시각을 모르면 독촉하지 않는다
  if (startMs === null || startDue === null || startEscalate === null) return { ...off, state: "TIME_UNKNOWN" };
  // 8. 아직 시작 전
  if (nowMs < startMs) return { ...base, state: "UPCOMING", dueAtMs: startDue, escalateAtMs: startEscalate };
  // 9. 시작 시각이 지났는데 시작을 안 눌렀다 — 유예 안에는 독촉 없이 «시작 시각 지남»만
  const nudge: ClassDayNudge = nowMs >= startEscalate ? "ESCALATE" : nowMs >= startDue ? "DUE" : "NONE";
  return { ...base, state: "NOT_STARTED", reasons: ["NOT_STARTED"], nudge, dueAtMs: startDue, escalateAtMs: startEscalate };
}

const HM_RE = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

/** "HH:MM"(또는 "H:MM"·"HH:MM:SS") 을 그 날짜의 절대 시각으로. 형식·범위가 틀리면 null */
function hmToMs(dateYmd: string, hm: string | null | undefined): number | null {
  const m = HM_RE.exec(String(hm ?? "").trim());
  if (!m) return null;
  if (Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const ms = kstAt(dateYmd, `${m[1]}:${m[2]}`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 정규 반의 시작·끝 글자("HH:MM", KST)를 절대 시각으로.
 * - 날짜나 시작 형식이 틀리면 시작 null(→ TIME_UNKNOWN, 독촉하지 않는다)
 * - 끝이 시작보다 이르거나 같으면(자정 넘김·입력 실수) 끝만 null — 시작 판정은 하고 끝 판정만 보류
 */
export function lessonWindowMs(
  dateYmd: string,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): { startMs: number | null; endMs: number | null } {
  if (!isKstYmd(dateYmd)) return { startMs: null, endMs: null };
  const startMs = hmToMs(dateYmd, startTime);
  let endMs = hmToMs(dateYmd, endTime);
  if (startMs !== null && endMs !== null && endMs <= startMs) endMs = null;
  return { startMs, endMs };
}

/** «미처리»인가 — 독촉 대상(DUE·ESCALATE) */
export function isClassDayOpen(status: ClassDayStatus): boolean {
  return status.nudge !== "NONE";
}

export type ClassDaySummary = { open: number; inProgress: number; done: number; upcoming: number; off: number };

/** 줄들을 요약 숫자로. 한 줄은 한 칸에만 들어간다(미처리가 가장 먼저). */
export function summarizeClassDay(rows: readonly { status: ClassDayStatus }[]): ClassDaySummary {
  const summary: ClassDaySummary = { open: 0, inProgress: 0, done: 0, upcoming: 0, off: 0 };
  for (const { status } of rows) {
    if (isClassDayOpen(status)) summary.open += 1;
    else if (status.state === "IN_PROGRESS" || status.state === "OVERRUN") summary.inProgress += 1;
    else if (status.state === "COMPLETED" || status.state === "RECORDED") summary.done += 1;
    else if (status.state === "HOLIDAY" || status.state === "CANCELLED" || status.state === "NO_STUDENTS") summary.off += 1;
    // 시작 전 · 시각 미정 · 시작 시각은 지났지만 아직 유예 안인 수업
    else summary.upcoming += 1;
  }
  return summary;
}

export type ClassDaySortable = { status: ClassDayStatus; startMs: number | null; name: string };

/**
 * 화면 정렬: ① 미처리 먼저(오래 밀린 것부터) ② 그 밖은 시작 시각순 → 반 이름순.
 * 이 칸의 존재 이유가 «놓친 수업 찾기»라, 시각순만 쓰면 오후에 미처리가 완료 줄 사이에 묻힌다.
 */
export function compareClassDayRows(a: ClassDaySortable, b: ClassDaySortable): number {
  const aOpen = isClassDayOpen(a.status);
  const bOpen = isClassDayOpen(b.status);
  if (aOpen !== bOpen) return aOpen ? -1 : 1;
  if (aOpen && bOpen) {
    const diff = (a.status.dueAtMs ?? Infinity) - (b.status.dueAtMs ?? Infinity);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
  }
  const aStart = a.startMs ?? Infinity;
  const bStart = b.startMs ?? Infinity;
  if (aStart !== bStart) return aStart < bStart ? -1 : 1;
  return a.name.localeCompare(b.name, "ko");
}

/** 화면 글자(상태 이름). 영문 상태 이름을 화면에 내보내지 않는다. */
export const CLASS_DAY_STATE_LABEL: Record<ClassDayState, string> = {
  HOLIDAY: "휴무",
  CANCELLED: "휴강",
  NO_STUDENTS: "대상 없음",
  UPCOMING: "시작 전",
  NOT_STARTED: "미시작",
  IN_PROGRESS: "진행 중",
  OVERRUN: "종료 지연",
  RECORDED: "출결만 입력",
  COMPLETED: "완료",
  TIME_UNKNOWN: "시간 미정",
};

/**
 * 줄의 상태 글자 — 상태 이름 + 이유. 아이 단위 말은 주간 출결 보드와 같은 «미확인 n».
 * 예) «미시작 · 미확인 8», «종료 지연 · 종료 안 누름», «진행 중 · 출결 5/8», «완료 · 미확인 1»
 */
export function classDayStatusText(status: ClassDayStatus, rosterCount: number): string {
  const label = CLASS_DAY_STATE_LABEL[status.state];
  const unmarked = status.unmarkedCount;
  switch (status.state) {
    case "NOT_STARTED":
      return unmarked > 0 ? `${label} · 미확인 ${unmarked}` : label;
    case "OVERRUN":
      return unmarked > 0 ? `${label} · 미확인 ${unmarked}` : `${label} · 종료 안 누름`;
    case "IN_PROGRESS": {
      const roster = count(rosterCount);
      return roster > 0 ? `${label} · 출결 ${Math.max(0, roster - unmarked)}/${roster}` : label;
    }
    case "COMPLETED":
      return unmarked > 0 ? `${label} · 미확인 ${unmarked}` : label;
    default:
      return label;
  }
}

/** 상태색 갈래(색 값은 화면 부품이 토큰으로 고른다). 색만으로 뜻을 전하지 않게 글자가 항상 같이 나간다. */
export type ClassDayTone = "danger" | "warning" | "progress" | "success" | "neutral";

export function classDayTone(status: ClassDayStatus): ClassDayTone {
  if (isClassDayOpen(status)) return "danger";                          // 미처리
  if (status.state === "NOT_STARTED") return "warning";                 // 시작 시각 지남(유예 안)
  if (status.state === "COMPLETED") return status.unmarkedCount > 0 ? "warning" : "success";
  if (status.state === "RECORDED") return "success";
  if (status.state === "IN_PROGRESS" || status.state === "OVERRUN") return "progress";
  return "neutral";                                                     // 시작 전·휴강·휴무·시간 미정
}

// ── «오늘 이 반 휴강» 표시 ────────────────────────────────────────────────────

export const CANCEL_REASON_MAX = 200;

/** 표가 아직 없을 때(운영 적용 전) 쓰기 요청에 돌려주는 안내 */
export const CANCEL_NOT_READY_MESSAGE = "휴강 표시 기능을 준비 중입니다. 잠시 후 다시 눌러 주세요.";
/** 실제 수업이 있었는데 독촉만 꺼지는 것을 막는 안내 */
export const CANCEL_BUSY_MESSAGE = "이미 시작했거나 출결이 있는 수업은 휴강으로 표시할 수 없습니다.";

/**
 * 확인 단계 문구. «휴강»이라는 말에서 학부모 알림·보강권·셔틀 중지까지 기대하지 않게,
 * 이 표시가 하는 일(독촉 멈춤)과 하지 않는 일을 같이 적는다. tests/class-nudge-dashboard.test.mjs 가 문구를 고정한다.
 */
export function cancelConfirmMessage(className: string): string {
  return `${className} 오늘 수업을 휴강으로 표시할까요?\n미처리 표시와 선생님 독촉만 멈춰요. 학부모 안내·보강권·셔틀은 바뀌지 않아요.`;
}

export type CancelInputCheck =
  | { ok: true; startTime: string; reason: string | null }
  | { ok: false; message: string };

/**
 * 휴강 표시·취소 입력 확인(순수). 문제가 없으면 저장할 모양으로 다듬어 돌려준다.
 * - 날짜: 실재하는 "YYYY-MM-DD" 이고 «오늘»(인자)일 것 — 1단계는 오늘만. 3단계가 지난 날짜로 넓힐 때 이 한 줄만 바꾼다.
 * - 정규: 그 반의 수업 요일과 날짜의 요일이 같을 것. 저장하는 startTime 은 ''.
 * - 특강: 회차 시작 시각 "HH:MM" 이 있어야 한다(같은 반이 하루에 두 회차일 수 있어 시각이 열쇠다).
 * - 사유: 앞뒤 공백 제거, 200자 이하, 없어도 된다.
 */
export function validateCancelInput(input: {
  date: unknown;
  today: string;
  kind: unknown;
  classDayOfWeek?: string | null;
  startTime?: unknown;
  reason?: unknown;
}): CancelInputCheck {
  const date = String(input.date ?? "").trim();
  if (!isKstYmd(date)) return { ok: false, message: "날짜를 다시 확인해 주세요." };
  if (date !== input.today) return { ok: false, message: "오늘 수업만 휴강으로 표시할 수 있습니다." };
  if (input.kind !== "REGULAR" && input.kind !== "SEASONAL") return { ok: false, message: "수업 종류를 확인할 수 없습니다." };

  const reasonText = String(input.reason ?? "").trim();
  if (reasonText.length > CANCEL_REASON_MAX) return { ok: false, message: `사유는 ${CANCEL_REASON_MAX}자까지 적을 수 있습니다.` };
  const reason = reasonText || null;

  if (input.kind === "REGULAR") {
    const dayKey = CLASS_DAY_KEYS[kstDow(date)];
    if (!input.classDayOfWeek || input.classDayOfWeek !== dayKey) {
      return { ok: false, message: "그 반의 수업 요일과 날짜의 요일이 다릅니다." };
    }
    return { ok: true, startTime: "", reason };
  }

  const startTime = String(input.startTime ?? "").trim();
  const m = /^(\d{2}):(\d{2})$/.exec(startTime);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { ok: false, message: "특강 회차의 시작 시각을 확인할 수 없습니다." };
  return { ok: true, startTime, reason };
}
