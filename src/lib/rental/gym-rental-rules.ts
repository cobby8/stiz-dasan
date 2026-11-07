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

// ── 요금(원장님 확정 2026-11-07, 문구 그대로) ───────────────────────────────
export const RENTAL_FEE = {
  firstHour: 40_000, // 1시간 40,000원
  extraHour: 30_000, // 이후 시간당 30,000원 추가
  airconPerHour: 5_000, // 냉난방 사용 시 시간당 5,000원
  baseHeadcount: 10, // 최대 10명
  extraPersonPerHour: 3_000, // 초과 시 1인당 1시간 3,000원
  deposit: 20_000, // 보증금(사용 후 환불)
} as const;

// ── 운영 범위 ───────────────────────────────────────────────────────────
/** 대관 칸을 보여 주는 시간 범위(KST 정시). 09시 시작 ~ 22시 종료(마지막 칸 21~22시). */
export const RENTAL_OPEN_HOUR = 9;
export const RENTAL_CLOSE_HOUR = 22;
/** 한 번에 신청할 수 있는 최대 시간 */
export const RENTAL_MAX_HOURS = 6;
/** 인원 입력 상한(실수 입력 방지). 10명 넘으면 추가 요금이 붙는다. */
export const RENTAL_MAX_HEADCOUNT = 30;
/** 오늘부터 며칠 뒤까지 신청을 받는가 */
export const RENTAL_BOOKING_DAYS = 60;

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
export type RentalFeeInput = { hours: number; headcount: number; useAircon: boolean };
export type RentalFeeBreakdown = {
  hours: number;
  headcount: number;
  baseFee: number; // 시간 요금
  airconFee: number; // 냉난방
  extraPeopleFee: number; // 인원 추가
  extraPeople: number;
  usageFee: number; // 이용료 합계
  deposit: number; // 보증금
  total: number; // 입금할 금액 = 이용료 + 보증금
};

/**
 * 대관 요금. 서버는 저장 직전에 **이 함수로 다시** 계산한다(화면 금액을 믿지 않는다).
 * 예) 2시간·12명·냉난방 = 40,000+30,000 + 5,000×2 + 2명×3,000×2 = 92,000 + 보증금 20,000 = 112,000
 */
export function calculateRentalFee(input: RentalFeeInput): RentalFeeBreakdown {
  const hours = Math.floor(Number(input.hours));
  const headcount = Math.floor(Number(input.headcount));
  if (!Number.isFinite(hours) || hours < 1 || hours > RENTAL_MAX_HOURS) {
    throw new Error(`이용 시간은 1~${RENTAL_MAX_HOURS}시간 사이로 골라 주세요.`);
  }
  if (!Number.isFinite(headcount) || headcount < 1 || headcount > RENTAL_MAX_HEADCOUNT) {
    throw new Error(`인원은 1~${RENTAL_MAX_HEADCOUNT}명 사이로 입력해 주세요.`);
  }
  const baseFee = RENTAL_FEE.firstHour + RENTAL_FEE.extraHour * (hours - 1);
  const airconFee = input.useAircon ? RENTAL_FEE.airconPerHour * hours : 0;
  const extraPeople = Math.max(0, headcount - RENTAL_FEE.baseHeadcount);
  const extraPeopleFee = extraPeople * RENTAL_FEE.extraPersonPerHour * hours;
  const usageFee = baseFee + airconFee + extraPeopleFee;
  return {
    hours,
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

// ── 가능 시간 계산 ────────────────────────────────────────────────────────
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

export type RentalClassRow = { dayOfWeek: string; startTime: string; endTime: string };
/** 그 날짜의 다른 사용(특강 회차·승인된 대관)을 «그날 KST 분» 구간으로 넘긴다 */
export type RentalBusyRange = { startMinute: number; endMinute: number };

export type RentalSlot = {
  hour: number; // 시작 시각(정시)
  label: string; // "09:00"
  available: boolean;
  reason: "OPEN" | "CLASS" | "BOOKED" | "PAST";
};

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** [aStart, aEnd) 와 [bStart, bEnd) 가 겹치는가(끝과 시작이 같으면 안 겹침) */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * 하루치 1시간 칸. 정규 수업(요일 반)·특강 회차·이미 승인된 대관과 겹치면 막고,
 * 이미 시작한 칸(오늘의 지난 시각)도 막는다.
 * - 정규 수업은 요일만 본다(dayOfWeek 가 Mon~Sun 인 반만 — Archived·Seasonal 은 제외).
 * - 연간일정 휴무일에도 정규 수업 시간은 막아 둔다(보수적 — 원장 판단으로 바꿀 수 있게 보고).
 */
export function buildRentalSlots(input: {
  date: string;
  classes: RentalClassRow[];
  busy: RentalBusyRange[]; // 특강 회차 + 승인된 대관
  bookedBusy?: RentalBusyRange[]; // 승인된 대관만 따로(사유 표시용). busy 에 포함돼 있어도 된다.
  nowMs: number;
}): RentalSlot[] {
  if (!isKstYmd(input.date)) return [];
  const dowCode = DOW_CODE[kstDow(input.date)];
  const classRanges = input.classes
    .filter((row) => row.dayOfWeek === dowCode)
    .map((row) => ({ startMinute: hmToMinutes(row.startTime), endMinute: hmToMinutes(row.endTime) }))
    .filter((row) => Number.isFinite(row.startMinute) && Number.isFinite(row.endMinute) && row.endMinute > row.startMinute);
  const booked = input.bookedBusy ?? [];

  const slots: RentalSlot[] = [];
  for (let hour = RENTAL_OPEN_HOUR; hour < RENTAL_CLOSE_HOUR; hour += 1) {
    const s = hour * 60;
    const e = s + 60;
    let reason: RentalSlot["reason"] = "OPEN";
    if (kstAt(input.date, hourLabel(hour)) <= input.nowMs) reason = "PAST";
    else if (classRanges.some((r) => overlaps(s, e, r.startMinute, r.endMinute))) reason = "CLASS";
    else if (booked.some((r) => overlaps(s, e, r.startMinute, r.endMinute))) reason = "BOOKED";
    else if (input.busy.some((r) => overlaps(s, e, r.startMinute, r.endMinute))) reason = "CLASS";
    slots.push({ hour, label: hourLabel(hour), available: reason === "OPEN", reason });
  }
  return slots;
}

/** 시작 칸에서 이어서 쓸 수 있는 최대 시간(중간에 막힌 칸이 나오면 거기까지) */
export function maxContinuousHours(slots: RentalSlot[], startHour: number): number {
  let count = 0;
  for (const slot of slots) {
    if (slot.hour < startHour) continue;
    if (slot.hour !== startHour + count || !slot.available) break;
    count += 1;
    if (count >= RENTAL_MAX_HOURS) break;
  }
  return count;
}

/** 신청한 [startHour, startHour+hours) 가 모두 가능한 칸인가 */
export function isRangeAvailable(slots: RentalSlot[], startHour: number, hours: number): boolean {
  if (!Number.isInteger(startHour) || !Number.isInteger(hours) || hours < 1) return false;
  return maxContinuousHours(slots, startHour) >= hours;
}

/** 신청 가능한 날짜인가(오늘 ~ 오늘+RENTAL_BOOKING_DAYS) */
export function isBookableDate(date: string, today: string): boolean {
  if (!isKstYmd(date) || !isKstYmd(today)) return false;
  return date >= today && date <= addDaysKst(today, RENTAL_BOOKING_DAYS);
}

/** KST 날짜+정시 → 절대 시각(ms). DB 의 startAt/endAt(timestamptz) 에 넣는 값. */
export function rentalInstantMs(date: string, hour: number): number {
  if (hour === 24) return kstAt(addDaysKst(date, 1), "00:00");
  return kstAt(date, hourLabel(hour));
}

export function rentalTimeLabel(startHour: number, endHour: number): string {
  return `${hourLabel(startHour)}~${hourLabel(endHour)}`;
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

function usageLine(input: RentalMessageInput): string {
  return `${dateText(input.rentalDate)} ${rentalTimeLabel(input.startHour, input.endHour)} · ${input.headcount}명${input.useAircon ? " · 냉난방" : ""}`;
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
