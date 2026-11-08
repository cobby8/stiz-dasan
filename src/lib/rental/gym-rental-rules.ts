/**
 * 체육관 대관 — 순수 규칙 모듈 (DB·next 의존 0).
 *
 * 왜 한 파일에 모으는가:
 *  - 요금은 화면(실시간 표시)과 서버(저장 직전 재계산)가 **같은 함수**를 써야 한다.
 *    한쪽만 고치면 손님이 본 금액과 승인 문자 금액이 달라진다.
 *  - 상태 전이(승인→입금 확인→…)도 버튼과 서버가 같은 표를 본다.
 *  - 이 파일은 tests/_ts-module.mjs 로 **실제 실행**해 검증한다.
 *
 * 날짜·시각은 @/lib/datetime/kst 만 쓴다(서버는 UTC, PC 는 KST).
 */
import { isKstYmd, kstAt, kstDow, addDaysKst } from "@/lib/datetime/kst";

// ── 요금(30분 단위 · 2026-11-08 원장 확정) ─────────────────────────────────
// 30분 단가가 기준값이다. 시간당 값(extraHour 등)은 안내 문구용으로 30분 단가×2 로 만든다
// → 정수 시간으로 쓰면 2026-11-07 시간 단위 요금과 금액이 정확히 같다(테스트로 확인).
const RENTAL_FEE_HALF = {
  firstHour: 40_000, // 첫 1시간 40,000원
  extraHalfHour: 15_000, // 그다음 30분마다 15,000원(= 시간당 30,000원의 절반)
  airconPerHalfHour: 2_500, // 냉난방 30분당 2,500원
  baseHeadcount: 10, // 최대 10명
  extraPersonPerHalfHour: 1_500, // 10명 초과 1인·30분당 1,500원
  deposit: 20_000, // 보증금(사용 후 환불)
} as const;

export const RENTAL_FEE = {
  ...RENTAL_FEE_HALF,
  extraHour: RENTAL_FEE_HALF.extraHalfHour * 2, // 시간당 30,000원(안내용)
  airconPerHour: RENTAL_FEE_HALF.airconPerHalfHour * 2, // 시간당 5,000원(안내용)
  extraPersonPerHour: RENTAL_FEE_HALF.extraPersonPerHalfHour * 2, // 1인·시간당 3,000원(안내용)
} as const;

// ── 운영 범위 ───────────────────────────────────────────────────────────
/** 평일 대관 시작 가능 시각(KST 정시) — 09:00 */
export const RENTAL_OPEN_HOUR = 9;
/** 주말(토·일) 대관 시작 가능 시각 — 10:00 (2026-11-08 원장 지시) */
export const RENTAL_WEEKEND_OPEN_HOUR = 10;
/** 모든 요일 종료 시각 — 22:00 까지 */
export const RENTAL_CLOSE_HOUR = 22;
export const RENTAL_CLOSE_MINUTE = RENTAL_CLOSE_HOUR * 60;
/** 시작 시각 간격(분) — 수업이 20:40 에 끝나면 20:40 부터 시작할 수 있게 10분 단위 */
export const RENTAL_START_STEP_MINUTES = 10;
/** 이용 시간 간격(분) — 30분 단위 */
export const RENTAL_DURATION_STEP_MINUTES = 30;
/** 최소 이용 시간(분) — 1시간 미만은 받지 않는다 */
export const RENTAL_MIN_MINUTES = 60;
/** 한 번에 신청할 수 있는 최대 시간 */
export const RENTAL_MAX_HOURS = 6;
export const RENTAL_MAX_MINUTES = RENTAL_MAX_HOURS * 60;
/** 인원 입력 상한(실수 입력 방지). 10명 넘으면 추가 요금이 붙는다. */
export const RENTAL_MAX_HEADCOUNT = 30;
/** 오늘부터 며칠 뒤까지 신청을 받는가 */
export const RENTAL_BOOKING_DAYS = 60;

/** 그날 대관을 시작할 수 있는 가장 이른 분(KST 0시 기준). 토·일 10:00, 평일 09:00. */
export function rentalOpenMinute(date: string): number {
  const dow = kstDow(date); // 요일은 kst 모듈(Date.UTC 기준)만 쓴다
  return (dow === 0 || dow === 6 ? RENTAL_WEEKEND_OPEN_HOUR : RENTAL_OPEN_HOUR) * 60;
}

// ── 상태 ────────────────────────────────────────────────────────────────
export const RENTAL_STATUSES = [
  "REQUESTED", // 신청 — 원장 승인 대기
  "APPROVED", // 승인 — 입금 대기
  "PAID", // 입금 확인 = 확정
  "COMPLETED", // 사용 완료 — 보증금 환불 대기
  "REFUNDED", // 보증금 환불 완료
  "REJECTED", // 거절
  "CANCELLED", // 취소(승인 뒤 미입금·고객 취소 등)
] as const;
export type RentalStatus = (typeof RENTAL_STATUSES)[number];

/**
 * 시간을 «차지하는» 상태 — 이 상태끼리는 시간이 겹치면 안 된다.
 * ⚠️ DB 의 EXCLUDE 제약(마이그레이션 20261107120000)의 WHERE 목록과 **같은 집합**이어야 한다.
 *    테스트가 두 목록을 비교한다(같은 규칙의 두 경로를 따로 고쳐 생긴 사고 2회 — errors.md).
 */
export const RENTAL_HOLDING_STATUSES: readonly RentalStatus[] = ["APPROVED", "PAID", "COMPLETED", "REFUNDED"];

export const RENTAL_STATUS_LABEL: Record<RentalStatus, string> = {
  REQUESTED: "승인 대기",
  APPROVED: "입금 대기",
  PAID: "확정",
  COMPLETED: "사용 완료",
  REFUNDED: "환불 완료",
  REJECTED: "거절",
  CANCELLED: "취소",
};

export type RentalAction = "approve" | "reject" | "confirmPayment" | "complete" | "refund" | "cancel";

/** 버튼 하나 = 상태 전이 하나. 화면 버튼과 서버 검증이 이 표를 같이 본다. */
export const RENTAL_TRANSITIONS: Record<RentalAction, { from: readonly RentalStatus[]; to: RentalStatus; label: string }> = {
  approve: { from: ["REQUESTED"], to: "APPROVED", label: "승인" },
  reject: { from: ["REQUESTED"], to: "REJECTED", label: "거절" },
  confirmPayment: { from: ["APPROVED"], to: "PAID", label: "입금 확인" },
  complete: { from: ["PAID"], to: "COMPLETED", label: "사용 완료" },
  refund: { from: ["COMPLETED"], to: "REFUNDED", label: "보증금 환불 완료" },
  cancel: { from: ["APPROVED", "PAID"], to: "CANCELLED", label: "대관 취소" },
};

export function isRentalStatus(value: unknown): value is RentalStatus {
  return typeof value === "string" && (RENTAL_STATUSES as readonly string[]).includes(value);
}

export function isRentalAction(value: unknown): value is RentalAction {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(RENTAL_TRANSITIONS, value);
}

/** 지금 상태에서 누를 수 있는 버튼 목록 */
export function allowedRentalActions(status: string): RentalAction[] {
  return (Object.keys(RENTAL_TRANSITIONS) as RentalAction[]).filter((action) =>
    (RENTAL_TRANSITIONS[action].from as readonly string[]).includes(status),
  );
}

// ── 요금 계산 ─────────────────────────────────────────────────────────────
export type RentalFeeInput = { durationMinutes: number; headcount: number; useAircon: boolean };
export type RentalFeeBreakdown = {
  durationMinutes: number;
  headcount: number;
  baseFee: number; // 시간 요금
  airconFee: number; // 냉난방
  extraPeopleFee: number; // 인원 추가
  extraPeople: number;
  usageFee: number; // 이용료 합계
  deposit: number; // 보증금
  total: number; // 입금할 금액 = 이용료 + 보증금
};

/** 이용 분이 규칙(60~360분, 30분 단위)에 맞는가 */
export function isValidRentalDuration(minutes: number): boolean {
  return Number.isInteger(minutes)
    && minutes >= RENTAL_MIN_MINUTES
    && minutes <= RENTAL_MAX_MINUTES
    && minutes % RENTAL_DURATION_STEP_MINUTES === 0;
}

/**
 * 대관 요금(30분 단위). 서버는 저장 직전에 **이 함수로 다시** 계산한다(화면 금액을 믿지 않는다).
 * 예) 2시간·12명·냉난방 = 40,000+15,000×2 + 2,500×4 + 2명×1,500×4 = 92,000 + 보증금 20,000 = 112,000
 * 예) 1시간 30분·10명 = 40,000+15,000 = 55,000
 */
export function calculateRentalFee(input: RentalFeeInput): RentalFeeBreakdown {
  const durationMinutes = Number(input.durationMinutes);
  const headcount = Math.floor(Number(input.headcount));
  if (!isValidRentalDuration(durationMinutes)) {
    throw new Error(`이용 시간은 1시간~${RENTAL_MAX_HOURS}시간 사이에서 30분 단위로 골라 주세요.`);
  }
  if (!Number.isFinite(headcount) || headcount < 1 || headcount > RENTAL_MAX_HEADCOUNT) {
    throw new Error(`인원은 1~${RENTAL_MAX_HEADCOUNT}명 사이로 입력해 주세요.`);
  }
  const halves = durationMinutes / RENTAL_DURATION_STEP_MINUTES; // 30분 칸 수(2~12)
  const baseFee = RENTAL_FEE.firstHour + RENTAL_FEE.extraHalfHour * (halves - 2); // 첫 1시간 = 30분 칸 2개
  const airconFee = input.useAircon ? RENTAL_FEE.airconPerHalfHour * halves : 0;
  const extraPeople = Math.max(0, headcount - RENTAL_FEE.baseHeadcount);
  const extraPeopleFee = extraPeople * RENTAL_FEE.extraPersonPerHalfHour * halves;
  const usageFee = baseFee + airconFee + extraPeopleFee;
  return {
    durationMinutes,
    headcount,
    baseFee,
    airconFee,
    extraPeopleFee,
    extraPeople,
    usageFee,
    deposit: RENTAL_FEE.deposit,
    total: usageFee + RENTAL_FEE.deposit,
  };
}

export function formatWon(amount: number): string {
  return `${Math.round(amount).toLocaleString("ko-KR")}원`;
}

// ── 가능 시간 계산(분 단위) ───────────────────────────────────────────────
const DOW_CODE = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "HH:MM" → 분. 형식이 틀리면 NaN */
export function hmToMinutes(hm: string | null | undefined): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm ?? "").trim());
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return NaN;
  return h * 60 + min;
}

/** 분 → "HH:MM" (1440 = "24:00") */
export function minuteLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** 분 길이 → "1시간 30분" / "2시간" / "30분" */
export function rentalDurationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}분`;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

/**
 * 대관 시간 표시는 **이 함수 하나로** — 관리자 화면·문자·카카오·슬랙·앱 알림이 모두 쓴다.
 * 예) 1240, 1330 → "20:40~22:10 (1시간 30분)"
 */
export function formatRentalTime(startMinute: number, endMinute: number): string {
  return `${minuteLabel(startMinute)}~${minuteLabel(endMinute)} (${rentalDurationLabel(endMinute - startMinute)})`;
}

/**
 * 저장된 행의 분 값. 분 컬럼이 비어 있는 옛 행(마이그레이션 전 저장분)은 정시 값으로 대신한다.
 * DB 조회는 COALESCE 로 이미 채워 오지만, 화면에 넘어온 값이 비어도 깨지지 않게 한 겹 더 둔다.
 */
export function rentalMinutesOf(row: { startHour: number; endHour: number; startMinute?: number | null; endMinute?: number | null }) {
  const startMinute = Number.isInteger(row.startMinute) ? Number(row.startMinute) : row.startHour * 60;
  const endMinute = Number.isInteger(row.endMinute) ? Number(row.endMinute) : row.endHour * 60;
  return { startMinute, endMinute };
}

export type RentalClassRow = { dayOfWeek: string; startTime: string; endTime: string };
/** 그 날짜의 다른 사용(특강 회차·승인된 대관)을 «그날 KST 분» 구간으로 넘긴다 */
export type RentalBusyRange = { startMinute: number; endMinute: number };

export type RentalBlockReason = "CLASS" | "BOOKED";
export type RentalBlock = RentalBusyRange & { reason: RentalBlockReason };

/** 시작 시각 후보 하나(10분 간격) */
export type RentalStartOption = {
  minute: number; // 그날 KST 0시부터 분
  label: string; // "20:40"
  available: boolean;
  reason: "OPEN" | "CLASS" | "BOOKED" | "PAST";
  maxMinutes: number; // 이 시각에 시작해 이어서 쓸 수 있는 최대 분(30분 단위, 못 쓰면 0)
};

/** 하루치 가능 시간 — 화면과 서버 검증이 같은 값을 본다 */
export type RentalDay = {
  date: string;
  openMinute: number; // 평일 540(09:00) · 주말 600(10:00)
  closeMinute: number; // 1320(22:00)
  blocks: RentalBlock[]; // 막힌 구간(수업·특강 = CLASS, 승인된 대관 = BOOKED)
  starts: RentalStartOption[];
};

/** [aStart, aEnd) 와 [bStart, bEnd) 가 겹치는가(끝과 시작이 같으면 안 겹침) */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** [start, end) 와 겹치는 막힌 구간의 사유(없으면 null). 수업이 예약보다 앞선다. */
function blockReason(blocks: RentalBlock[], start: number, end: number): RentalBlockReason | null {
  const hit = blocks.filter((b) => overlaps(start, end, b.startMinute, b.endMinute));
  if (hit.length === 0) return null;
  return hit.some((b) => b.reason === "CLASS") ? "CLASS" : "BOOKED";
}

/** 시작 분에서 이어서 쓸 수 있는 최대 분(60~360, 30분 단위). 1시간도 못 쓰면 0. */
function maxMinutesFrom(blocks: RentalBlock[], start: number, closeMinute: number): number {
  let max = 0;
  for (let d = RENTAL_MIN_MINUTES; d <= RENTAL_MAX_MINUTES && start + d <= closeMinute; d += RENTAL_DURATION_STEP_MINUTES) {
    if (blockReason(blocks, start, start + d)) break;
    max = d;
  }
  return max;
}

/**
 * 하루치 시작 후보(10분 간격). 정규 수업(요일 반)·특강 회차·이미 승인된 대관과 겹치면 막고,
 * 이미 지난 시각도 막는다. 시작 후보는 «영업 시작 ~ 22:00 - 1시간» 범위다.
 * - 정규 수업은 요일만 본다(dayOfWeek 가 Mon~Sun 인 반만 — Archived·Seasonal 은 제외).
 * - 연간일정 휴무일에도 정규 수업 시간은 막아 둔다(보수적 — 원장 판단으로 바꿀 수 있게 보고).
 */
export function buildRentalDay(input: {
  date: string;
  classes: RentalClassRow[];
  busy: RentalBusyRange[]; // 특강 회차 (+ 승인된 대관이 섞여 있어도 된다)
  bookedBusy?: RentalBusyRange[]; // 승인된 대관(사유 «예약됨» 표시용)
  nowMs: number;
}): RentalDay | null {
  if (!isKstYmd(input.date)) return null;
  const dowCode = DOW_CODE[kstDow(input.date)];
  const valid = (r: RentalBusyRange) => Number.isFinite(r.startMinute) && Number.isFinite(r.endMinute) && r.endMinute > r.startMinute;
  const classBlocks: RentalBlock[] = input.classes
    .filter((row) => row.dayOfWeek === dowCode)
    .map((row) => ({ startMinute: hmToMinutes(row.startTime), endMinute: hmToMinutes(row.endTime), reason: "CLASS" as const }))
    .filter(valid);
  const bookedBlocks: RentalBlock[] = (input.bookedBusy ?? []).filter(valid).map((r) => ({ ...r, reason: "BOOKED" as const }));
  // busy 는 특강 회차 — 예약 목록과 똑같은 구간이면 예약으로 본다(사유 표시만 다르다)
  const otherBlocks: RentalBlock[] = input.busy
    .filter(valid)
    .filter((r) => !bookedBlocks.some((b) => b.startMinute === r.startMinute && b.endMinute === r.endMinute))
    .map((r) => ({ ...r, reason: "CLASS" as const }));
  const blocks = [...classBlocks, ...otherBlocks, ...bookedBlocks].sort((a, b) => a.startMinute - b.startMinute);

  const openMinute = rentalOpenMinute(input.date);
  const closeMinute = RENTAL_CLOSE_MINUTE;
  const dayStartMs = kstAt(input.date); // 그날 KST 0시
  const starts: RentalStartOption[] = [];
  for (let minute = openMinute; minute + RENTAL_MIN_MINUTES <= closeMinute; minute += RENTAL_START_STEP_MINUTES) {
    let reason: RentalStartOption["reason"] = "OPEN";
    let maxMinutes = 0;
    if (dayStartMs + minute * 60_000 <= input.nowMs) reason = "PAST";
    else {
      // 최소 1시간 안에 막힌 구간이 있으면 그 사유, 없으면 이어서 쓸 수 있는 최대 시간을 센다
      reason = blockReason(blocks, minute, minute + RENTAL_MIN_MINUTES) ?? "OPEN";
      if (reason === "OPEN") maxMinutes = maxMinutesFrom(blocks, minute, closeMinute);
    }
    starts.push({ minute, label: minuteLabel(minute), available: reason === "OPEN" && maxMinutes > 0, reason, maxMinutes });
  }
  return { date: input.date, openMinute, closeMinute, blocks, starts };
}

/**
 * 신청한 [startMinute, startMinute+durationMinutes) 를 쓸 수 있는가 — 서버 검증의 기준.
 * 화면 값을 믿지 않고 시작 10분 단위·이용 30분 단위(60~360)·영업 시간·겹침을 모두 다시 본다.
 */
export function isRentalRangeAvailable(day: RentalDay | null, startMinute: number, durationMinutes: number): boolean {
  if (!day) return false;
  if (!Number.isInteger(startMinute) || startMinute % RENTAL_START_STEP_MINUTES !== 0) return false;
  if (!isValidRentalDuration(durationMinutes)) return false;
  if (startMinute < day.openMinute || startMinute + durationMinutes > day.closeMinute) return false;
  const option = day.starts.find((s) => s.minute === startMinute);
  return !!option && option.available && option.maxMinutes >= durationMinutes;
}

/** 신청 가능한 날짜인가(오늘 ~ 오늘+RENTAL_BOOKING_DAYS) */
export function isBookableDate(date: string, today: string): boolean {
  if (!isKstYmd(date) || !isKstYmd(today)) return false;
  return date >= today && date <= addDaysKst(today, RENTAL_BOOKING_DAYS);
}

/** KST 날짜 + 그날 0시부터 분 → 절대 시각(ms). DB 의 startAt/endAt(timestamptz)에 넣는 값. 한국은 서머타임이 없다. */
export function rentalInstantMs(date: string, minute: number): number {
  return kstAt(date) + minute * 60_000;
}

/** 분 → 기존 정시 컬럼 값(startHour 내림 · endHour 올림). DB CHECK(endHour > startHour)를 늘 만족한다. */
export function rentalHourColumns(startMinute: number, endMinute: number): { startHour: number; endHour: number } {
  return { startHour: Math.floor(startMinute / 60), endHour: Math.ceil(endMinute / 60) };
}

// ── 달력(신청 화면) ───────────────────────────────────────────────────────
/** "YYYY-MM" 에 n달 더하기(달력 이동용 — 시간대가 끼지 않는 정수 계산) */
export function shiftYm(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

export type RentalCalendarCell = { date: string; day: number; bookable: boolean; isToday: boolean } | null;

/**
 * 월 달력 칸(일요일 시작, 앞쪽 빈칸은 null). bookable = 오늘~60일 안.
 * 날짜·요일은 kst 모듈(addDaysKst·kstDow)만 쓴다.
 */
export function buildRentalCalendar(ym: string, today: string): RentalCalendarCell[] {
  const first = `${ym}-01`;
  if (!isKstYmd(first)) return [];
  const cells: RentalCalendarCell[] = Array.from({ length: kstDow(first) }, () => null);
  for (let date = first; date.startsWith(ym); date = addDaysKst(date, 1)) {
    cells.push({ date, day: Number(date.slice(8, 10)), bookable: isBookableDate(date, today), isToday: date === today });
  }
  return cells;
}

// ── 입력 정리 ─────────────────────────────────────────────────────────────
/** 휴대폰 번호 → 숫자만. 010으로 시작하는 10~11자리만 받는다. 틀리면 "" */
export function normalizeRentalPhone(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!/^01[016789]\d{7,8}$/.test(digits)) return "";
  return digits;
}

export function formatRentalPhone(digits: string): string {
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits;
}

/** 자유 입력 글자 정리 — 앞뒤 공백 제거, 줄바꿈 정리, 길이 제한 */
export function cleanRentalText(raw: unknown, maxLength: number): string {
  return String(raw ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, maxLength);
}

// ── 계좌 ─────────────────────────────────────────────────────────────────
// 🚫 입금 계좌 값은 이 파일에 두지 않는다. 이 파일은 공개 신청 화면(RentalClient)이 import 해서
//    손님 브라우저 번들에 그대로 실린다. 계좌는 서버 전용 gym-rental-notify.ts 에만 있다(테스트가 번들 경로를 검사).

// ── 원장 알림 묶기 ───────────────────────────────────────────────────────
/** 원장 알림 문자는 10분 창마다 한 통 — 같은 창에 들어온 신청은 문자 한 통으로 묶는다(슬랙은 건별) */
export const RENTAL_ADMIN_SMS_WINDOW_MS = 10 * 60_000;

export function rentalAdminSmsWindowKey(createdAtMs: number): string {
  return `rental-window:${Math.floor(createdAtMs / RENTAL_ADMIN_SMS_WINDOW_MS)}`;
}

// ── 확정 뒤 취소 환불 ────────────────────────────────────────────────────
/** 입금 확인(확정) 뒤 취소는 돌려준 금액(0~입금액)을 꼭 적는다. 맞으면 금액, 틀리면 null */
export function parseCancelRefund(raw: unknown, totalAmount: number): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > totalAmount) return null;
  return value;
}

// ── 문자 문구 ─────────────────────────────────────────────────────────────
export type RentalMessageInput = {
  applicantName: string;
  applicantPhone: string; // 숫자만
  rentalDate: string;
  startHour: number;
  endHour: number;
  startMinute?: number | null; // 분 단위 시각(없으면 정시 값으로 대신)
  endMinute?: number | null;
  headcount: number;
  useAircon: boolean;
  usageFee: number;
  deposit: number;
  totalAmount: number;
  purpose?: string | null;
};

function dateText(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = ["일", "월", "화", "수", "목", "금", "토"][kstDow(date)];
  return `${y}년 ${m}월 ${d}일(${dow})`;
}

/** 저장된 행 → "20:40~22:10 (1시간 30분)" (알림·문자·관리자 화면 공용) */
export function rentalTimeText(row: { startHour: number; endHour: number; startMinute?: number | null; endMinute?: number | null }): string {
  const { startMinute, endMinute } = rentalMinutesOf(row);
  return formatRentalTime(startMinute, endMinute);
}

function usageLine(input: RentalMessageInput): string {
  return `${dateText(input.rentalDate)} ${rentalTimeText(input)} · ${input.headcount}명${input.useAircon ? " · 냉난방" : ""}`;
}

/** 원장님께 가는 «새 신청» 알림 (문자·슬랙 공용) */
export function buildRentalAdminAlert(input: RentalMessageInput, pendingCount = 1): string {
  return [
    // 10분 안에 여러 건이 들어오면 문자는 첫 건만 가므로, 대기 건수를 함께 알린다
    pendingCount > 1 ? `[STIZ 체육관 대관 신청 · 승인 대기 ${pendingCount}건]` : "[STIZ 체육관 대관 신청]",
    `${input.applicantName} ${formatRentalPhone(input.applicantPhone)}`,
    usageLine(input),
    `이용료 ${formatWon(input.usageFee)} + 보증금 ${formatWon(input.deposit)} = ${formatWon(input.totalAmount)}`,
    input.purpose ? `목적: ${input.purpose.slice(0, 60)}` : "",
    "승인·거절: 관리자 > 체육관 대관",
  ].filter(Boolean).join("\n");
}

const RENTAL_NOTICE_LINES = [
  "· 실내운동화 필수 지참·착용",
  "· 건물 주차가 어려워요. 인근 주민센터 주차장을 이용해 주세요.",
];

/** 신청자 — 접수 안내(스위치로 꺼 둠) */
export function buildRentalReceivedApplicantSms(input: RentalMessageInput): string {
  return [
    "[스티즈농구교실] 체육관 대관 신청이 접수되었습니다.",
    usageLine(input),
    `예상 금액 ${formatWon(input.totalAmount)}(이용료 ${formatWon(input.usageFee)} + 보증금 ${formatWon(input.deposit)})`,
    "원장님 확인 후 승인 문자와 입금 계좌를 보내 드립니다. 승인 전에는 입금하지 마세요.",
  ].join("\n");
}

/** 신청자 — 승인 + 입금 계좌(스위치로 꺼 둠) */
export function buildRentalApprovedApplicantSms(input: RentalMessageInput, bankAccount: string): string {
  return [
    "[스티즈농구교실] 체육관 대관이 승인되었습니다.",
    usageLine(input),
    `입금 금액 ${formatWon(input.totalAmount)}(이용료 ${formatWon(input.usageFee)} + 보증금 ${formatWon(input.deposit)})`,
    `입금 계좌: ${bankAccount}`,
    `입금자명은 신청자 이름(${input.applicantName})으로 해 주세요. 입금이 확인되면 대관이 확정됩니다.`,
    "보증금은 사용 후 환불되며, 정리정돈·냉난방·인원 미준수 시 차감될 수 있습니다.",
  ].join("\n");
}

/** 신청자 — 입금 확인 = 확정(스위치로 꺼 둠) */
export function buildRentalConfirmedApplicantSms(input: RentalMessageInput): string {
  return [
    "[스티즈농구교실] 체육관 대관이 확정되었습니다.",
    usageLine(input),
    "장소: 스티즈농구교실 다산2호점(다산동 6158-4, 1층)",
    ...RENTAL_NOTICE_LINES,
    "사용 후 정리정돈 확인이 끝나면 보증금을 환불해 드립니다.",
  ].join("\n");
}
