// 부상·질병 «기간 결석» 복귀 정산 규칙 — 순수 모듈(DB·React 없음. node 테스트가 바로 실행한다).
//
// 원장 결정(2026-11-15): 기간 결석은 «인정(승인)»과 «금액 확정(정산)»을 나눈다.
//   · 승인 = 금액 없이 «이 기간은 부상 결석으로 인정한다»만 기록한다(돈이 움직이지 않는다).
//   · 금액은 복귀한 뒤 한 번에 정한다(다음 단계에서 만든다).
// 비유: 외상 장부에 이름만 먼저 올려 두고(승인), 금액은 나중에 한 번에 적는다(정산).
//
// 날짜는 전부 «YYYY-MM-DD»(KST 달력 날짜) 글자로 받는다 — 달력 계산은 공용 모듈(kst.ts)에서만 한다.
import { addDaysKst, isKstYmd } from "@/lib/datetime/kst";

/** 기간의 정산 상태 — DB CHECK 제약(RegularAbsencePeriod_carryState_check)과 같은 집합(테스트가 비교) */
export const PERIOD_CARRY_STATES = ["NONE", "APPROVED", "SETTLED", "REFUND_REVIEW", "REFUND_DONE"] as const;
export type PeriodCarryState = (typeof PERIOD_CARRY_STATES)[number];

/** 신청함에서 «부상 결석(기간)»만 보는 주소 — 여러 날 질병·부상 결석 알림이 여는 곳 */
export const ILLNESS_PERIOD_INBOX_HREF = "/admin/inbox?kind=ILLNESS_PERIOD";

/** 학부모 화면: 승인된 기간의 상태 글자(금액은 아직 정하지 않았다) */
export const PERIOD_APPROVED_PARENT_LABEL = "부상 결석 인정 · 금액은 복귀 뒤 확정";
/** 학부모 화면: 수업일 줄에 붙는 짧은 글자(좁은 줄이라 한 단어) */
export const PERIOD_APPROVED_DAY_LABEL = "부상 결석 인정";
/** 학부모 화면·앱 알림: 승인 안내 한 줄 */
export const PERIOD_APPROVED_PARENT_NOTE = "금액은 복귀 뒤에 정해 다음 수강료에서 빼 드려요.";
/** 관리자 상세: 승인 뒤 안내 한 줄 */
export const PERIOD_APPROVED_ADMIN_NOTE = "금액은 복귀한 뒤 한 번에 정산해요";
/** 승인된 기간의 결석을 하루씩 이월 승인하려 할 때 거절하는 글 */
export const PERIOD_DAY_RESOLVE_BLOCKED = "기간 정산에서 한 번에 처리합니다. 신청함의 «부상 결석(기간)»에서 확인해 주세요.";

/** 이 프로그램이 처리하지 못하게 막은 요청(한국어 사유를 그대로 화면에 보인다) */
export class IllnessPeriodError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "IllnessPeriodError";
    this.status = status;
  }
}

/** «2026-11-06» → «11/6» */
function monthDay(ymd: string): string {
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
}

/**
 * 기간 글자 — 복귀 미정이면 «11/6 ~», 복귀일이 있으면 마지막으로 쉬는 날(복귀일 전날)까지 «11/6 ~ 11/27».
 * 하루짜리 기간이면 «11/6».
 */
export function periodRangeText(startYmd: string, returnYmd: string | null | undefined): string {
  if (!isKstYmd(startYmd)) return "";
  if (!returnYmd || !isKstYmd(returnYmd)) return `${monthDay(startYmd)} ~`;
  const lastYmd = addDaysKst(returnYmd, -1);
  return lastYmd <= startYmd ? monthDay(startYmd) : `${monthDay(startYmd)} ~ ${monthDay(lastYmd)}`;
}

/** 신청함 한 줄 요약 — «11/6 ~ · 16회 · 사진 2장» */
export function periodInboxSummary(input: { startYmd: string; returnYmd: string | null; count: number; photoCount: number }): string {
  return [
    periodRangeText(input.startYmd, input.returnYmd),
    `${Math.max(0, Math.trunc(input.count) || 0)}회`,
    input.photoCount > 0 ? `사진 ${Math.trunc(input.photoCount)}장` : "사진 없음",
  ].filter(Boolean).join(" · ");
}

/** 지금 [부상 결석 승인]을 누를 수 없는 이유 한 줄(없으면 null). 날짜·청구 기록·청구 준비 저장 스위치는 보지 않는다 */
export function periodApprovalBlocker(input: { reason: string; periodStatus: string; carryState: string }): string | null {
  if (input.reason !== "ILLNESS_INJURY") return "질병·부상으로 등록한 기간 결석만 승인할 수 있습니다.";
  if (input.carryState === "APPROVED") return "이미 승인된 기간 결석입니다.";
  if (input.carryState !== "NONE") return "이미 정산이 끝난 기간 결석입니다.";
  if (input.periodStatus === "CANCELLED") return "등록 취소된 기간 결석입니다.";
  return null;
}

// ── SQL 조각(코드에 적힌 별칭만 받는다 — 사용자 입력 아님) ───────────────────────────────
// 왜 조각인가: «신청함에 기간으로 보이는 결석»과 «하루짜리 목록에서 빼는 결석»이 같은 조건을 써야
// 한쪽에만 뜨거나 양쪽 다 안 뜨는 일이 없다(같은 규칙의 경로가 둘이면 한 곳에서 만든다).

/**
 * 신청함에 «기간 한 줄»로 올리는 기간인가 — 질병·부상 기간이고, 등록 취소되지 않았거나 이미 승인·정산된 것.
 * (승인한 뒤 등록 취소한 기간도 남겨 둔다 — 원장이 «승인 취소»를 누를 곳이 있어야 한다)
 */
export function illnessPeriodVisibleSql(period: string): string {
  return `(${period}.reason = 'ILLNESS_INJURY' AND (${period}.status <> 'CANCELLED' OR ${period}."carryState" <> 'NONE'))`;
}

/**
 * 결석 정산·보강권 발급이 시작된 날 — 그 전 결석은 대상이 아니다.
 * 보강권 쪽 상수 MAKEUP_CREDIT_ISSUE_FROM_YMD(credit-service.ts)와 «같은 값»이어야 한다(테스트가 비교).
 * 그 파일은 prisma 를 부르고 이 파일은 순수 모듈(화면·node 테스트가 바로 읽는다)이라 가져오지 못하고 값을 맞춰 둔다.
 */
export const ILLNESS_PERIOD_FROM_YMD = "2026-10-05";

/** 그 기간(period)에 묶인 살아 있는 질병·부상 결석(abs)인가 — 정산이 시작된 날(ILLNESS_PERIOD_FROM_YMD) 이후만 */
export function illnessPeriodAbsenceSql(period: string, abs: string): string {
  return `(${abs}."periodId" = ${period}.id AND ${abs}.status <> 'CANCELLED' AND ${abs}.reason = 'ILLNESS_INJURY' AND ${abs}.date >= '${ILLNESS_PERIOD_FROM_YMD}'::date)`;
}

/**
 * 그 결석(abs)의 보강이 이미 예약·사용됐는가 — 보강권 RESERVED/USED/NO_SHOW 또는 보강 예약 BOOKED/ATTENDED/NO_SHOW.
 * 기간 승인은 이런 날을 «이월 대상»으로 표시하지 않는다(보강으로 보상이 진행 중이다).
 * 보강권 키·보강 예약의 결석일 비교는 기존 규칙과 같다(originalDate 는 timestamptz 라 KST 변환 한 번, date 칼럼은 그대로).
 * withSessions=false 는 보강 예약 표가 아직 없는 DB 용.
 */
export function makeupInUseSql(abs: string, withSessions = true): string {
  const credit = `EXISTS (SELECT 1 FROM "MakeupCredit" used_credit
                   WHERE used_credit."studentId" = ${abs}."studentId"
                     AND used_credit."sourceKey" = 'REGULAR:' || ${abs}."classId" || ':' || to_char(${abs}.date, 'YYYY-MM-DD')
                     AND used_credit.status IN ('RESERVED', 'USED', 'NO_SHOW'))`;
  if (!withSessions) return `(${credit})`;
  return `(${credit} OR EXISTS (SELECT 1 FROM "MakeupSession" used_session
                   WHERE used_session."studentId" = ${abs}."studentId" AND used_session."originalClassId" = ${abs}."classId"
                     AND to_char(used_session."originalDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') = to_char(${abs}.date, 'YYYY-MM-DD')
                     AND used_session.status IN ('BOOKED', 'ATTENDED', 'NO_SHOW')))`;
}

/**
 * 학부모 화면에 보일 그 결석의 상태 — «검토 줄»이 아니라 «기간 상태» 기준.
 *   · 승인된 기간(APPROVED)에 묶인 질병·부상 결석: 검토 줄이 없거나 «검토 중»·«승인»이면 «부상 결석 인정 · 금액은 복귀 뒤»
 *     (승인 뒤 매일 연장·학부모 연장으로 생긴 날도 같은 글자)
 *   · 단, 하루씩 실제로 이월 적립된 날(settled)은 기존 «이월 승인» 그대로
 *   · 보강권으로 전환된 날(MAKEUP)·승인되지 않은 기간·하루 결석은 검토 상태 그대로
 */
export function parentPeriodDayStatus(input: {
  reviewStatus: string | null; reason: string; periodCarryState: string | null; settled: boolean;
}): { status: string; amountPending: boolean } {
  const review = input.reviewStatus ?? "PENDING";
  const recognized = input.periodCarryState === "APPROVED" && input.reason === "ILLNESS_INJURY" && !input.settled
    && (review === "PENDING" || review === "APPROVED");
  return recognized ? { status: "APPROVED", amountPending: true } : { status: review, amountPending: false };
}

/** 승인 때 남긴 «되돌릴 재료» — 거둔 보강권 id 와 새로 만든 검토 줄의 결석 id */
export type PeriodApprovalRecord = { revokedCreditIds: string[]; createdReviewAbsenceIds: string[] };

/** 기간 행의 carrySettlement(jsonb) 에서 승인 기록을 꺼낸다. 모양이 다르거나 없으면 빈 목록(아무것도 되돌리지 않는다) */
export function parsePeriodApprovalRecord(value: unknown): PeriodApprovalRecord {
  let parsed: unknown = value;
  if (typeof value === "string") { try { parsed = JSON.parse(value); } catch { parsed = null; } }
  const approval = parsed && typeof parsed === "object" ? (parsed as { approval?: unknown }).approval : null;
  const ids = (list: unknown): string[] => (Array.isArray(list)
    ? Array.from(new Set(list.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 200)))
    : []);
  const record = approval && typeof approval === "object" ? approval as Record<string, unknown> : {};
  return { revokedCreditIds: ids(record.revokedCreditIds), createdReviewAbsenceIds: ids(record.createdReviewAbsenceIds) };
}

// ── 청구 발행 보류(2단계, 2026-11-15 원장 결정) ─────────────────────────────────────────
// 보류는 «표시 칸»이 아니라 계산값이다: 그 학생에게 승인됐고(APPROVED) 금액이 아직 확정되지 않은 질병·부상 기간이 있다.
// 칸을 따로 두면 승인 취소 때 한쪽만 고쳐지는 사고가 난다 → 아래 조각 하나로만 판정한다(청구 준비·신청함·학부모 화면·학생 상세 공용).

/** 청구 준비 행·차단 사유에 쓰는 글자 */
export const BILLING_HOLD_LABEL = "부상 결석 중 · 발행 보류";
/** 학생 상세 수강·출결 카드에 쓰는 글자 */
export const BILLING_HOLD_STUDENT_LABEL = "부상 결석 중 · 청구 보류";
/** 신청함 목록의 상태 값(승인 + 보류 중) — catalog.ts 의 ILLNESS_PERIOD 상태 지도와 같은 값이어야 한다(테스트가 비교) */
export const PERIOD_HOLD_INBOX_STATUS = "APPROVED_HOLD";
/** 학부모 결제 화면·앱 알림: 보류 안내 한 줄(«학원에 문의» 대신 상태를 그대로 보인다) */
export function billingHoldParentText(studentName: string): string {
  return `${studentName} · 부상 결석 중이라 수강료 청구를 잠시 멈췄어요. 복귀하면 빠진 수업을 뺀 금액으로 다시 안내해요.`;
}

/** 그 기간(period)이 «청구 발행 보류»를 만드는 상태인가 — 승인됐고 금액 미확정, 등록 취소되지 않음 */
export function illnessHoldPeriodSql(period: string): string {
  return `(${period}.reason = 'ILLNESS_INJURY' AND ${period}."carryState" = 'APPROVED' AND ${period}.status IN ('ACTIVE', 'ENDED'))`;
}

/**
 * 그 학생(student 별칭)의 청구 발행이 보류 중인가 — 보류 판정은 이 조각 하나로만 한다.
 * ready=false(기간 정산 칸이 아직 없는 DB)면 항상 false — 없는 칸을 읽지 않는다.
 */
export function illnessBillingHoldSql(student: string, ready = true): string {
  if (!ready) return "false";
  return `EXISTS (SELECT 1 FROM "RegularAbsencePeriod" hold_period
                   WHERE hold_period."studentId" = ${student}.id AND ${illnessHoldPeriodSql("hold_period")})`;
}

/** 보류로 돌린 청구 한 건의 사본(기간 행 carrySettlement.held 에 남긴다 — 금액·달·반을 나중에 대조할 수 있게) */
export type HeldBillRecord = {
  paymentId: string; invoiceId: string; year: number; month: number; classId: string | null;
  amount: number; draftId: string | null; heldAt: string;
};

/** 기간 행의 carrySettlement(jsonb) 에서 보류로 돌린 청구 목록을 꺼낸다. 모양이 다르면 그 줄은 버린다 */
export function parseHeldBills(value: unknown): HeldBillRecord[] {
  let parsed: unknown = value;
  if (typeof value === "string") { try { parsed = JSON.parse(value); } catch { parsed = null; } }
  const held = parsed && typeof parsed === "object" ? (parsed as { held?: unknown }).held : null;
  if (!Array.isArray(held)) return [];
  return held.filter((item): item is HeldBillRecord => Boolean(item) && typeof item === "object"
    && typeof (item as HeldBillRecord).paymentId === "string" && Number.isSafeInteger((item as HeldBillRecord).amount));
}

/** 발행된 미납 청구를 보류로 돌릴 수 없는 이유(화면에 그대로 보인다) */
export const HOLD_SKIP_REASONS = {
  CHECKOUT: "학부모가 결제하는 중이라 건너뜁니다. 잠시 뒤 다시 확인해 주세요.",
  POS: "현장 결제 요청 중이라 건너뜁니다. 요청이 끝난 뒤 다시 확인해 주세요.",
  PAID_TX: "결제 거래 기록이 있어 직접 확인이 필요합니다.",
  CARRY_USED: "이월을 쓴 청구라 직접 확인이 필요합니다.",
  CARRY_SOURCE: "이 청구를 근거로 적립한 이월이 있어 직접 확인이 필요합니다.",
  PAUSE_SETTLED: "휴원 정산이 반영된 청구라 직접 확인이 필요합니다.",
  INVOICE: "청구서 상태를 확인할 수 없어 건너뜁니다.",
} as const;
export type HoldSkipCode = keyof typeof HOLD_SKIP_REASONS;

/** 하루짜리 목록(ILLNESS_CARRY)에서 뺄 결석(abs)인가 — 신청함에 기간 한 줄로 올라가는 기간에 묶인 결석 */
export function boundToIllnessPeriodSql(abs: string): string {
  return `EXISTS (SELECT 1 FROM "RegularAbsencePeriod" illness_period
                   WHERE illness_period.id = ${abs}."periodId" AND ${illnessPeriodVisibleSql("illness_period")})`;
}

/** 그 결석(abs)의 기간이 이미 승인·정산됐는가 — 하루씩 이월 승인·7일 자동 보강권 전환을 막는 조건 */
export function periodCarryDecidedSql(abs: string): string {
  return `EXISTS (SELECT 1 FROM "RegularAbsencePeriod" decided_period
                   WHERE decided_period.id = ${abs}."periodId" AND decided_period."carryState" <> 'NONE')`;
}
