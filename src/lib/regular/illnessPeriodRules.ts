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

/** 그 기간(period)에 묶인 살아 있는 질병·부상 결석(abs)인가 — 2026-10-05 = 결석 정산이 시작된 날(그 전 결석은 대상이 아니다) */
export function illnessPeriodAbsenceSql(period: string, abs: string): string {
  return `(${abs}."periodId" = ${period}.id AND ${abs}.status <> 'CANCELLED' AND ${abs}.reason = 'ILLNESS_INJURY' AND ${abs}.date >= '2026-10-05'::date)`;
}

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
