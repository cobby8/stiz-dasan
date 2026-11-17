/**
 * 월 청구일 계산 — 순수 규칙(2026-11-17 원장 확정).
 *
 * ■ 규칙
 *   기본 월 청구서는 «전달 개강일 + 14일»에 나간다.
 *   예) 2027년 1월 청구 = 12월 개강(2026-12-01) + 14일 = 2026-12-15.
 *
 * ■ 개강일은 어디서 읽나
 *   연간계획표(학원 구글 캘린더 + AnnualEvent 표)의 «N월 개강» 일정이다.
 *   청구일 계산에서는 공용 OPEN_RE 보다 좁게 본다(검수 B-6): 제목이 «N월 개강»(또는 «N월 개강일»)으로 «끝나야» 한다.
 *   «12월 개강 준비 회의»처럼 뒤에 다른 글자가 붙으면 개강이 아니다. 공용 정규식(classSchedule.ts)은 건드리지 않는다.
 *   «겨울방학특강 1차 개강»처럼 특강·방학 개강은 월 개강이 아니라서 뺀다.
 *
 * ■ 추정 금지
 *   개강 일정이 없거나, 같은 달 개강이 서로 다른 날짜로 두 개 이상이면 청구일을 정하지 않는다(null 성격의 결과).
 *   잘못된 날에 초안을 만드는 것보다 «정할 수 없음»을 보여 원장이 연간계획표를 고치게 하는 쪽이 안전하다.
 *
 * ⚠️ 날짜는 "YYYY-MM-DD" 문자열로만 다룬다. 달력 계산은 @/lib/datetime/kst 함수만 쓴다.
 * ⚠️ 이 파일은 prisma·next 를 import 하지 않는다(테스트에서 그대로 실행).
 */
import { addDaysKst, addMonthsYm, diffDaysKst, isKstYmd, kstLabel, toKstYmd } from "@/lib/datetime/kst";
import { AUTO_DRAFT_ACTOR, isAutoDraftCandidate, type WorkbenchRow } from "./workbench";

/** 개강일에서 청구일까지 더하는 날 수(원장 확정 2026-11-17) */
export const BILLING_DAY_OFFSET = 14;

/** 연간계획표 일정 한 건(loadAnnualPlanEventsWithSource·청구 준비 달력 스냅샷과 같은 모양) */
export type PlanEvent = { title: string; date: string; endDate?: string };

/** 특강·방학 개강은 «월 개강»이 아니다(예: 겨울방학특강 1차 개강) */
const SPECIAL_OPEN_RE = /특강|방학/;
/** 청구일 계산용 «N월 개강» — 제목 끝에 와야 한다(앞에 학원 이름 등은 괜찮다, 뒤에 다른 글자는 안 된다) */
const BILLING_OPEN_RE = /(?:^|\s)(\d{1,2})월\s*개강(?:일)?$/;

export type BillingDayResult =
  /** 청구일을 정했다 */
  | { status: "OK"; billingMonth: string; billingDate: string; openMonth: string; openDate: string }
  /** 전달 «N월 개강» 일정이 없다 */
  | { status: "NO_OPEN"; billingMonth: string; openMonth: string }
  /** 전달 «N월 개강»이 서로 다른 날짜로 여러 개 있다(어느 쪽인지 추정하지 않는다) */
  | { status: "CONFLICT"; billingMonth: string; openMonth: string; openDates: string[] };

/**
 * 일정의 날짜 값 → KST 달력 날짜.
 * 종일 일정은 «그 날짜의 UTC 자정»으로 들어온다(구글 일정 정규화·AnnualEvent date 열) — 앞 10글자가 그 날짜다.
 * 시각이 있는 일정이면 한국 날짜로 바꾼다.
 */
function eventYmd(value: string): string {
  const text = String(value ?? "");
  if (isKstYmd(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(text)) return text.slice(0, 10);
  return toKstYmd(text);
}

/**
 * «N월 개강» 일정 하나 → 그 개강이 속한 수강월("YYYY-MM").
 * 제목에는 월만 있으므로 연도는 일정 날짜와 비교해 정한다(공개 연간일정표와 같은 규칙):
 * 일정 월 − 제목 월 > 6 이면 다음 해(예: 12월에 적힌 «1월 개강»), < −6 이면 이전 해.
 */
export function openMonthOf(event: PlanEvent): { openMonth: string; openDate: string } | null {
  if (!event || typeof event.title !== "string" || SPECIAL_OPEN_RE.test(event.title)) return null;
  const match = BILLING_OPEN_RE.exec(event.title.trim());
  if (!match) return null;
  const titleMonth = Number(match[1]);
  if (!Number.isInteger(titleMonth) || titleMonth < 1 || titleMonth > 12) return null;
  const openDate = eventYmd(event.date);
  if (!isKstYmd(openDate)) return null;
  const eventYear = Number(openDate.slice(0, 4)), eventMonth = Number(openDate.slice(5, 7));
  const diff = eventMonth - titleMonth;
  const year = diff > 6 ? eventYear + 1 : diff < -6 ? eventYear - 1 : eventYear;
  return { openMonth: `${year}-${String(titleMonth).padStart(2, "0")}`, openDate };
}

/**
 * 청구월("YYYY-MM")의 청구일 = 전달 «N월 개강» + 14일.
 * 연도 경계도 같은 규칙이다: 2027-01 청구 → 2026-12 개강을 찾는다.
 */
export function billingDayFor(events: readonly PlanEvent[], billingMonth: string): BillingDayResult {
  const openMonth = addMonthsYm(billingMonth, -1);
  // 같은 날짜의 같은 개강이 구글 일정·AnnualEvent 에 둘 다 있으면 하나로 본다
  const openDates = [...new Set(events.map(openMonthOf).filter((o) => o?.openMonth === openMonth).map((o) => o!.openDate))].sort();
  if (!openMonth || openDates.length === 0) return { status: "NO_OPEN", billingMonth, openMonth };
  if (openDates.length > 1) return { status: "CONFLICT", billingMonth, openMonth, openDates };
  return { status: "OK", billingMonth, billingDate: addDaysKst(openDates[0], BILLING_DAY_OFFSET), openMonth, openDate: openDates[0] };
}

/**
 * 오늘(KST "YYYY-MM-DD")이 청구일인 청구월 목록(보통 0개 또는 1개).
 * 일정에 있는 모든 «N월 개강»에서 청구일을 계산해 오늘과 같은 것만 고른다.
 * 같은 달 개강이 날짜가 다르게 겹친 달(CONFLICT)은 고르지 않는다 — 추정해서 초안을 만들지 않는다.
 */
export function billingMonthsDueOn(events: readonly PlanEvent[], todayYmd: string): string[] {
  if (!isKstYmd(todayYmd)) return [];
  const billingMonths = new Set(events.map(openMonthOf).filter(Boolean).map((o) => addMonthsYm(o!.openMonth, 1)));
  return [...billingMonths].filter((month) => {
    const day = billingDayFor(events, month);
    return day.status === "OK" && day.billingDate === todayYmd;
  }).sort();
}

/** 청구일 당일에 못 만들었을 때 다시 시도하는 날 수(청구일 +1 ~ +3일, 검수 B-4) */
export const BILLING_DRAFT_CATCH_UP_DAYS = 3;

/**
 * 오늘 자동 초안을 «시도할» 청구월 목록 — 청구일 당일(catchUp=false)과 청구일 +1~+3일(catchUp=true).
 * 따라잡기 날에는 그 달에 자동 초안이 아직 하나도 없을 때만 실제로 만든다(부르는 쪽 cron 이 확인).
 */
export function billingMonthsToTry(events: readonly PlanEvent[], todayYmd: string): Array<{ month: string; billingDate: string; catchUp: boolean }> {
  if (!isKstYmd(todayYmd)) return [];
  const billingMonths = new Set(events.map(openMonthOf).filter(Boolean).map((o) => addMonthsYm(o!.openMonth, 1)));
  const out: Array<{ month: string; billingDate: string; catchUp: boolean }> = [];
  for (const month of [...billingMonths].sort()) {
    const day = billingDayFor(events, month);
    if (day.status !== "OK") continue;
    const late = diffDaysKst(day.billingDate, todayYmd);
    if (late >= 0 && late <= BILLING_DRAFT_CATCH_UP_DAYS) out.push({ month, billingDate: day.billingDate, catchUp: late > 0 });
  }
  return out;
}

/**
 * 다음 달 청구일을 정하지 못했는가(«청구일을 정하지 못했습니다» 알림용, 검수 B-4).
 * 이번 달 개강 일정이 없거나 겹쳤는데 이번 달 15일이 지났으면(보통 개강 + 14일 무렵) 알릴 달을 돌려준다. 아니면 null.
 */
export function undeterminedBillingMonth(events: readonly PlanEvent[], todayYmd: string): { month: string; reason: string } | null {
  if (!isKstYmd(todayYmd) || Number(todayYmd.slice(8, 10)) < 15) return null;
  const next = addMonthsYm(todayYmd.slice(0, 7), 1);
  const day = billingDayFor(events, next);
  return day.status === "OK" ? null : { month: next, reason: billingDayNotice(events, next) };
}

// ── 청구일 자동 초안(cron /api/cron/billing-draft) 의 «어느 행을 저장하나» 규칙 ─────────────────────
//
// 초안 저장(SAVE)은 이 시스템에서 «관리자가 검토했다»는 뜻이다 — 같은 원본으로 저장된 행은 검토 사유가
// (구조적인 것만 빼고) 지워지고 READY 가 된다(workbench-service readWorkbench 의 saved.sourceVersion 비교).
// 그래서 구체 사유(셔틀 중복·고정 수강료·월 중간 등록·차단·발행 보류 등)가 있는 행, 그리고 사유 문구가 없어도
// 이월 차감·기간 조정(3회 달 차감·부상 결석 정산 포함 — 0원이 아닌 모든 조정)이 들어간 행은 자동 저장하지 않고
// 개수만 센다 — 사람이 안 본 경고·금액이 그냥 넘어가지 않게(검수 B-2). 그 밖에 검토 사유가 없거나 «일반 문구» 하나뿐인 행만 저장한다
// (판정 isAutoDraftCandidate, PM 결정 2026-11-17: 일반 문구는 원장이 «승인 대기»에서 금액을 보고 승인하는 것이 검토다).
// 저장자는 AUTO_DRAFT_ACTOR 라 화면에서 «자동 초안(원장 확인 전)»으로 사람 저장과 구분된다.
// 이미 초안·확정·발행(·0원 정산)이 있는 행은 건너뛴다 — cron 이 두 번 돌아도 결과가 같다.
// 그 달 셔틀 명단이 없으면 행 판정 전에 cron 이 통째로 멈춘다(셔틀비가 0원으로 제안되기 때문, 검수 B-1).

/** 자동 초안 저장 사유(감사 기록 BillingWorkbenchRevision.reason 에 그대로 남는다) */
export const AUTO_DRAFT_REASON_PREFIX = "청구일 자동 초안";
/** 자동 초안을 만든 주체(정의는 workbench.ts — 화면·서버가 같은 글자를 쓴다) */
export { AUTO_DRAFT_ACTOR };

type AutoDraftRow = Pick<WorkbenchRow, "id" | "status" | "draftStatus" | "blockingReasons" | "reviewReasons" | "hold" | "version"
  | "baseAmount" | "discountAmount" | "prorationAmount" | "carryAmount" | "shuttleAmount" | "periodStart" | "periodEnd"> & Partial<Pick<WorkbenchRow, "guideMissedDates">>;

export type AutoDraftPlan = {
  /** mutateWorkbench SAVE 에 그대로 넣을 행(제안값 그대로) */
  saveRows: Array<{ id: string; expectedVersion: number; baseAmount: number; discountAmount: number; prorationAmount: number;
    carryAmount: number; shuttleAmount: number; reason: string; periodStart?: string; periodEnd?: string }>;
  /** 검토 필요로 남겨 둔 행 수(발행 보류 제외) */
  review: number;
  /** 발행 보류 행 수(부상 결석 기간 정산 대기) */
  hold: number;
  /** 이미 초안·확정·발행이 있어 건너뛴 행 수 */
  already: number;
  /** 이번 달 청구 대상이 아닌 행 수 */
  excluded: number;
};

/** readWorkbench 결과 행 → 자동 초안 계획. 순수 함수(쓰기 없음). */
export function planAutoDraft(rows: readonly AutoDraftRow[], billingDate: string): AutoDraftPlan {
  const plan: AutoDraftPlan = { saveRows: [], review: 0, hold: 0, already: 0, excluded: 0 };
  const reason = `${AUTO_DRAFT_REASON_PREFIX}(${billingDate}) — 제안값 그대로 저장, 원장 확인 전`;
  for (const row of rows) {
    if (row.status === "EXCLUDED") { plan.excluded++; continue; }
    if (row.status === "ISSUED" || row.draftStatus !== null) { plan.already++; continue; }
    if (row.hold) { plan.hold++; continue; }
    if (!isAutoDraftCandidate(row)) { plan.review++; continue; }
    // 화면의 «검토 저장»과 같은 모양: 기간이 있으면 함께 보낸다(기간 조정액이 있는 행은 기간이 꼭 있어야 저장된다)
    const start = row.periodStart?.slice(0, 10), end = row.periodEnd?.slice(0, 10);
    plan.saveRows.push({ id: row.id, expectedVersion: row.version, baseAmount: row.baseAmount, discountAmount: row.discountAmount,
      prorationAmount: row.prorationAmount, carryAmount: row.carryAmount, shuttleAmount: row.shuttleAmount, reason,
      ...(start && end ? { periodStart: start, periodEnd: end } : {}) });
  }
  return plan;
}

/** 자동 초안 요청 번호 — 같은 원본(sourceVersion)이면 같은 번호라, 두 번 보내도 한 번만 저장된다 */
export function autoDraftRequestId(month: string, sourceVersion: string): string {
  return `auto-draft-${month}-${sourceVersion.slice(0, 40)}`;
}

/**
 * 청구 준비 화면을 열 때 기본으로 보일 달(2026-11-17 PM 결정).
 * 오늘이 «다음 달 청구일» 이후면(다음 달 청구가 이미 시작됐으면) 다음 달, 아니면 이번 달.
 * 다음 달 청구일을 정할 수 없으면(개강 일정 없음·중복) 이번 달 그대로.
 */
export function defaultWorkbenchMonth(events: readonly PlanEvent[], todayYmd: string): string {
  const thisMonth = todayYmd.slice(0, 7);
  const next = addMonthsYm(thisMonth, 1);
  const day = next ? billingDayFor(events, next) : null;
  return day?.status === "OK" && todayYmd >= day.billingDate ? next : thisMonth;
}

/** "2027-01" → "1월" (화면 문구용) */
const monthWord = (ym: string) => `${Number(ym.slice(5, 7))}월`;

/**
 * 청구 준비 화면 맨 위 안내 한 줄.
 * 예) «이 달 청구일: 12/15(화) — 12월 개강 12/1(화) + 14일»
 */
export function billingDayNotice(events: readonly PlanEvent[], billingMonth: string): string {
  const day = billingDayFor(events, billingMonth);
  if (day.status === "NO_OPEN") return `연간계획표에 ${monthWord(day.openMonth || billingMonth)} 개강 일정이 없어 청구일을 정할 수 없습니다.`;
  if (day.status === "CONFLICT") return `연간계획표에 ${monthWord(day.openMonth)} 개강 일정이 ${day.openDates.length}개(${day.openDates.map(kstLabel).join("·")})라 청구일을 정할 수 없습니다. 하나만 남겨 주세요.`;
  return `이 달 청구일: ${kstLabel(day.billingDate)} — ${monthWord(day.openMonth)} 개강 ${kstLabel(day.openDate)} + ${BILLING_DAY_OFFSET}일`;
}
