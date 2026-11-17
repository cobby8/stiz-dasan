import { addMonthsYm, isKstYmd } from "@/lib/datetime/kst";
/** 청구 검토표의 공통 계약. 화면 입력과 서버의 계산 근거를 분리한다. */
export type WorkbenchAmounts = { baseAmount: number; discountAmount: number; prorationAmount: number; carryAmount: number; shuttleAmount: number };
export type WorkbenchCalendarSnapshot = { kind:"DB"|"DB_AND_ICS"; events:Array<{title:string;date:string;endDate?:string}>; fingerprint:string };
export type WorkbenchRow = WorkbenchAmounts & {
  id: string; studentId: string; studentName: string; classId: string; className: string;
  status: "READY" | "REVIEW" | "EXCLUDED" | "ISSUED";
  totalAmount: number; reviewReasons: string[]; basis: string[]; version: number;
  draftStatus: "DRAFT" | "CONFIRMED" | "ISSUED" | "ZERO" | null; paymentId: string | null;
  periodStart: string | null; periodEnd: string | null; scheduledDates: string[];
  /** 연간 일정상 그달 전체 수업일(기간을 좁히기 전). 3회 달 판정·화면 자동 재계산에 쓴다. */
  monthDates: string[];
  carryAvailable: number; remainingCarry: number;
  dueDate: string;
  blockingReasons: string[];
  /** 부상·질병 기간 결석이 승인돼 금액이 정해질 때까지 발행을 보류한 행(보류 행에만 있다) */
  hold?: true;
  /** 보류를 만든 기간 id — 화면이 신청함 기간 상세로 보낸다 */
  holdPeriodId?: string;
  /** 부상 결석 안내에서 «달 가운데만 빠진 날» — 이 날들은 수업일 목록(scheduledDates)에서 빠져 있다(다닌 날만). 저장할 때 근거에 함께 적는다 */
  guideMissedDates?: string[];
  /** 학생별 고정 월 수강료가 적용된 행의 짧은 근거(예: «고정 15만») — 그런 행에만 있다(2026-11-16) */
  fixedTuitionLabel?: string;
  /** 청구일 cron 이 만든 초안이고 아직 사람이 다시 저장하지 않은 행(초안 상태일 때만 있다, 2026-11-17) */
  autoDraft?: true;
};
export type WorkbenchAbsence = {
  id: string; studentId: string; studentName: string; classId: string; date: string;
  reason: string; status: string; makeupStatus: string | null; resolution: string | null;
  reviewReasons: string[];
  /** 승인·정산된 질병 기간에 묶인 결석이면 그 기간 id — 하루씩 처리하지 않고 «기간 정산에서 처리»로 보인다(이 칸은 그런 결석에만 있다) */
  carryPeriodId?: string;
};
export type WorkbenchView = {
  month: string; sourceVersion: string; writesEnabled: boolean; storageReady: boolean;
  rows: WorkbenchRow[]; absences: WorkbenchAbsence[];
  summary: { total: number; ready: number; review: number; excluded: number; issued: number; totalAmount: number };
  carrySettlementReady: boolean;
  notices: string[];
  calendarSource: "DB" | "DB_AND_ICS";
  /** 그 달 셔틀 명단이 하나도 없다(셔틀비 제안 0원) — 자동 초안·한꺼번에 발행을 막는다. 명단이 있으면 칸이 없다 */
  shuttleRosterMissing?: true;
  /**
   * 그 달 셔틀 명단에 학생 연결 없이 이름만 있고, 그 이름이 어떤 수강 행과도 맞지 않는 사람(누군지 모름) — 있을 때만 칸이 있다.
   * 셔틀비를 받아야 할 학생이 0원으로 빠졌을 수 있어 자동 초안·한꺼번에 발행을 멈춘다(재검수 C-1, 2026-11-17).
   */
  shuttleUnlinkedNames?: string[];
};
export type WorkbenchEdit = Partial<WorkbenchAmounts> & { id: string; expectedVersion: number; reason?: string; periodStart?:string; periodEnd?:string };
export type WorkbenchCommand = {
  action: "SAVE" | "CONFIRM" | "ISSUE"; month: string; sourceVersion: string;
  requestId: string; rows: WorkbenchEdit[];
};
export type WorkbenchOperation = { requestId: string; action: string; rowIds: string[]; paymentIds: string[]; zeroCount: number };
export class WorkbenchError extends Error {
  constructor(message: string, readonly status = 400, readonly refreshRequired = false) { super(message); this.name = "WorkbenchError"; }
}
export const WORKBENCH_MAX_AMOUNT = 100_000_000;

// ── 청구일 자동 초안 · 승인 대기(2026-11-17 원장 목표 «눈으로 보고 승인 버튼만») ─────────────────────
/** 확정 장부가 없는 청구 행에 늘 붙는 일반 검토 문구 — 이 문구 «하나뿐»인 행은 자동 초안 대상이다 */
export const WORKBENCH_GENERIC_REVIEW_REASON = "할인·셔틀 및 수강 기간을 검토해 주세요.";
/** 저장 뒤 원본(수강·결석·청구 등)이 바뀐 초안에 붙는 문구 */
export const WORKBENCH_SOURCE_CHANGED_REASON = "검토 후 원본이 변경되었습니다. 다시 저장·확정해 주세요.";
/** 자동 초안을 저장한 주체 — 감사 기록 actorUserId 칸(사람 계정 id 와 겹치지 않는 고정 글자) */
export const AUTO_DRAFT_ACTOR = "SYSTEM_CRON_BILLING_DRAFT";
/** 화면에서 자동 초안을 사람 저장과 구분하는 이름 */
export const AUTO_DRAFT_LABEL = "자동 초안(원장 확인 전)";

/**
 * 그 달 셔틀 명단이 없을 때(readWorkbench 가 shuttleRosterMissing 을 붙인다) 쓰는 글자.
 * 명단이 없으면 셔틀비가 0원으로 제안되므로, 자동 초안·한꺼번에 발행을 막는다(검수 B-1, 2026-11-17).
 */
export function shuttleRosterMissingMessage(month: string, use: "AUTO_DRAFT" | "APPROVE"): string {
  const m = Number(String(month).slice(5, 7)) || 0;
  return use === "AUTO_DRAFT"
    ? `${m}월 셔틀 명단이 아직 없어 자동 초안을 만들지 않았습니다. 셔틀 명단을 확인한 뒤 청구 준비 화면에서 직접 저장해 주세요.`
    : `${m}월 셔틀 명단이 아직 없어 한꺼번에 발행할 수 없습니다. 셔틀 명단을 먼저 확인해 주세요.`;
}

/**
 * 셔틀 명단에 학생 연결 없이 «이름만» 있는 기록과 이름이 같은 학생의 행에 붙는 구체 검토 사유(재검수 C-1).
 * 그 학생이 실제로 셔틀을 타는데 셔틀비가 0원으로 제안됐을 수 있다 — 일반 문구가 아니라서 자동 초안·승인 대기에서 빠지고 «확인 필요»로 간다.
 * 동명이인이면 그 이름의 행 모두에 붙는다.
 */
export const SHUTTLE_UNLINKED_REASON = "셔틀 명단에 학생 연결이 빠져 셔틀비를 못 넣었습니다 — 확인해 주세요";
/** 셔틀 명단 비교용 이름(앞뒤·가운데 띄어쓰기 무시) */
export const shuttleNameKey = (name: string) => String(name ?? "").replace(/\s+/g, "");
/** 누군지 모르는 연결 빠진 이름이 있을 때의 글자 — cron 알림 제목·한꺼번에 발행 거절·화면 안내가 같은 함수를 쓴다 */
export function shuttleUnlinkedMessage(month: string, names: readonly string[], use: "AUTO_DRAFT" | "APPROVE" | "TITLE"): string {
  const m = Number(String(month).slice(5, 7)) || 0;
  const list = names.slice(0, 5).join(", ") + (names.length > 5 ? ` 외 ${names.length - 5}명` : "");
  if (use === "TITLE") return `${m}월 셔틀 명단에 학생과 연결 안 된 이름이 있습니다: ${list}`;
  return use === "AUTO_DRAFT"
    ? `${m}월 셔틀 명단에 학생과 연결 안 된 이름(${list})이 있어 자동 초안을 만들지 않았습니다. 셔틀 명단에서 학생을 연결한 뒤 청구 준비 화면에서 확인해 주세요.`
    : `${m}월 셔틀 명단에 학생과 연결 안 된 이름(${list})이 있어 한꺼번에 발행할 수 없습니다. 셔틀 명단에서 학생을 먼저 연결해 주세요.`;
}

type AutoDraftAmountRow = Pick<WorkbenchRow, "carryAmount" | "prorationAmount" | "guideMissedDates">;
type AutoDraftCheckRow = Pick<WorkbenchRow, "status" | "draftStatus" | "hold" | "blockingReasons" | "reviewReasons" | "autoDraft" | "remainingCarry" | "periodStart" | "periodEnd" | "scheduledDates"> & Partial<AutoDraftAmountRow>;

/**
 * 사유 문구는 없어도 사람이 금액을 봐야 하는 행(검수 B-2·운영 실측 2026-11-17).
 * 이월 차감 · 기간 조정(3회 달 차감·월 중간 등록·부상 결석 정산 등 0원이 아닌 모든 조정) · 부상 결석 «달 가운데 빠짐» 행.
 * 돌려주는 글자는 «확인 필요» 목록의 한 줄 사유로 쓴다. 해당 없으면 null.
 */
export function amountCheckReason(row: Partial<AutoDraftAmountRow>): string | null {
  const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
  if ((row.carryAmount ?? 0) > 0) return `이월 차감 ${won(row.carryAmount!)} — 확인해 주세요`;
  if (row.guideMissedDates?.length) return `부상 결석 정산 — 다닌 날만 청구했는지 확인해 주세요`;
  if ((row.prorationAmount ?? 0) !== 0) return `기간 조정 ${won(row.prorationAmount!)} — 확인해 주세요`;
  return null;
}

/**
 * 청구일 cron 이 «제안값 그대로» 초안을 저장해도 되는 행인가.
 * = 아직 초안이 없고 · 발행 보류·차단 사유가 없고 · 검토 사유가 하나도 없거나 «일반 문구» 하나뿐이고
 *   · 이월 차감·기간 조정(3회 달 차감·부상 결석 정산 포함)이 없는 행.
 * 셔틀 중복·고정 수강료·월 중간 등록 같은 구체 사유나 위 금액 조정이 하나라도 있으면 사람이 본다(대상 아님).
 */
export function isAutoDraftCandidate(row: Pick<WorkbenchRow, "status" | "draftStatus" | "hold" | "blockingReasons" | "reviewReasons"> & Partial<AutoDraftAmountRow>): boolean {
  if (row.status === "EXCLUDED" || row.status === "ISSUED" || row.draftStatus !== null || row.hold || row.blockingReasons.length) return false;
  if (amountCheckReason(row)) return false;
  if (row.status === "READY") return true;
  return row.reviewReasons.length > 0 && row.reviewReasons.every((reason) => reason === WORKBENCH_GENERIC_REVIEW_REASON);
}

/**
 * «승인 대기» 묶음에 넣고 한꺼번에 발행해도 되는 자동 초안인가(화면·서버 같은 판정).
 * 초안 저장 뒤 원본이 바뀌어 «원본 변경» 문구가 붙었어도, 그 밖의 구체 사유가 없으면 그대로 승인할 수 있다
 * — 승인할 때 원장이 화면에서 본 금액으로 다시 저장한 뒤 확정·발행하기 때문이다.
 * 단 원본이 바뀐 초안인데 쓸 수 있는 이월 잔액이 남아 있으면(새 이월이 생겼을 수 있다) 사람이 본다.
 * 이월 차감·기간 조정이 들어간 행도 사람이 본다(amountCheckReason).
 */
export function isApprovableAutoDraft(row: AutoDraftCheckRow): boolean {
  if (!row.autoDraft || row.draftStatus !== "DRAFT" || row.hold || row.blockingReasons.length) return false;
  if (row.status === "EXCLUDED" || row.status === "ISSUED") return false;
  if (!row.periodStart || !row.periodEnd || !row.scheduledDates.length) return false;
  if (amountCheckReason(row)) return false;
  if (!row.reviewReasons.every((reason) => reason === WORKBENCH_GENERIC_REVIEW_REASON || reason === WORKBENCH_SOURCE_CHANGED_REASON)) return false;
  return !row.reviewReasons.includes(WORKBENCH_SOURCE_CHANGED_REASON) || row.remainingCarry === 0;
}

/** «확인 필요» 목록에 보일 한 줄 사유 — 구체 사유를 먼저, 다음은 금액 조정(이월·기간 조정), 없으면 일반 문구 */
export function reviewHeadline(row: Pick<WorkbenchRow, "reviewReasons" | "blockingReasons"> & Partial<AutoDraftAmountRow>): string {
  const concrete = [...row.blockingReasons, ...row.reviewReasons].find((reason) => reason !== WORKBENCH_GENERIC_REVIEW_REASON && reason !== WORKBENCH_SOURCE_CHANGED_REASON);
  return concrete ?? amountCheckReason(row) ?? row.reviewReasons[0] ?? "확인할 내용이 있습니다.";
}
export function filterWorkbenchDates(dates:readonly string[],start:string,end:string) {
  for(const value of [start,end]) if(!isKstYmd(value))throw new WorkbenchError("수강 시작·종료 날짜를 확인해 주세요.");
  if(start>end || Date.parse(end)-Date.parse(start)>61*86400000)throw new WorkbenchError("수강 기간은 날짜 순서에 맞게 62일 이내로 입력해 주세요.");
  return [...new Set(dates)].filter(d=>d>=start&&d<=end).sort();
}
export function validateWorkbenchMonth(value: unknown): string {
  if (typeof value !== "string" || !/^(20[2-9]\d|2100)-(0[1-9]|1[0-2])$/.test(value)) throw new WorkbenchError("대상 월을 확인해 주세요.");
  return value;
}
export function validateWorkbenchAmounts(value: WorkbenchAmounts): WorkbenchAmounts {
  for (const amount of Object.values(value)) if (!Number.isSafeInteger(amount) || amount < 0 || amount > WORKBENCH_MAX_AMOUNT) throw new WorkbenchError("금액은 0~100,000,000원의 정수로 입력해 주세요.");
  if (value.discountAmount + value.prorationAmount + value.carryAmount > value.baseAmount) throw new WorkbenchError("차감 합계가 기준 수강료보다 큽니다.");
  return value;
}
export function workbenchTotal(value: WorkbenchAmounts) {
  validateWorkbenchAmounts(value);
  return value.baseAmount - value.discountAmount - value.prorationAmount - value.carryAmount + value.shuttleAmount;
}
/** 프로그램 수강료(정가)가 기준으로 삼는 한 달 수업 횟수. */
export const STANDARD_MONTHLY_SESSIONS = 4;
/**
 * 연간 일정상 그달 수업이 4회보다 적을 때 빼는 금액(원장 결정 2026-10-30).
 * 기준은 **할인 후 금액**이다: (정가 − 할인) × 모자란 회차 ÷ 4.
 * 예: 정가 100,000·할인 0·3회 → 25,000원 / 정가 100,000·할인 10,000·3회 → 22,500원.
 * 그래야 결석 이월 1회분(할인 후 금액 ÷ 그달 횟수)이 4회 달과 같은 값이 된다.
 * 수업일을 못 읽었거나(0회) 4회 이상, 할인 후 금액이 0 이하이면 0원.
 */
export function shortMonthProration(baseAmount: number, sessions: number, discountAmount = 0): number {
  if (!Number.isSafeInteger(baseAmount) || !Number.isSafeInteger(discountAmount) || discountAmount < 0) return 0;
  const net = baseAmount - discountAmount;
  if (net <= 0) return 0;
  if (!Number.isInteger(sessions) || sessions <= 0 || sessions >= STANDARD_MONTHLY_SESSIONS) return 0;
  return Math.round(net * (STANDARD_MONTHLY_SESSIONS - sessions) / STANDARD_MONTHLY_SESSIONS);
}
/**
 * 부상 결석 복귀 정산(2026-11-15): 낸 돈이 없는 달을 «다닌 횟수만큼만» 청구할 때의 기간 조정 금액.
 * 한 번 값 = (할인 후 금액 − 3회 달 차감) ÷ 그 달 수업 횟수 → 청구 = 한 번 값 × 다닌 횟수(한 번 반올림) → 기간 조정 = 할인 후 금액 − 청구.
 * 예: 105,000원·4회 달·2회 다님 → 청구 52,500 → 기간 조정 52,500 / 전부 빠짐 → 기간 조정 105,000(청구 0원).
 * 낸 달의 이월 한 번 값(낸 금액 ÷ 수업 횟수)과 같은 단가다.
 */
export function attendedOnlyProration(net: number, shortProration: number, sessions: number, attended: number): number {
  if (!Number.isSafeInteger(net) || net <= 0 || !Number.isInteger(sessions) || sessions <= 0) return 0;
  const count = Math.min(Math.max(0, Math.trunc(attended) || 0), sessions);
  const payable = Math.max(0, net - Math.max(0, Number.isSafeInteger(shortProration) ? shortProration : 0));
  return net - Math.round(payable * count / sessions);
}
/**
 * 발행 초안의 근거(calculationBasis)에서 «부상 결석으로 뺀 날»을 꺼낸다 — 달 가운데만 빠진 달로 발행한 초안에만 있다.
 * 그 초안의 수업일 사본(scheduledDates)에는 다닌 날만 들어 있어, 지금 일정과 견줄 때 같은 날을 빼고 견줘야 한다(청구 준비 · 이월 근거 공용).
 */
export function illnessMissedDatesOf(calculationBasis: unknown): string[] {
  const list = calculationBasis && typeof calculationBasis === "object" ? (calculationBasis as { illnessMissedDates?: unknown }).illnessMissedDates : null;
  return Array.isArray(list) ? list.filter((date): date is string => typeof date === "string" && isKstYmd(date)) : [];
}
/**
 * 결석일이 속한 «수강월»(YYYY-MM)을 연간 일정으로 정한다 — 청구(Payment.year/month)·이월 근거의 달이다(하루짜리 이월 · 기간 정산 공용).
 * 달력 월과 다를 수 있다(예: 12월 1주차가 11/30 에 시작하면 11/30 결석은 12월 수강월). 그래서 달력 월 → 다음 달 → 이전 달 순으로
 * «그 달 수업일에 이 날이 있는가»를 본다. 어느 달에도 없으면(휴무일 등) 달력 월 — 뒤의 규칙이 «수업일 아님»으로 거른다.
 * 달력 월을 먼저 보므로, 달력 월에 수업일이 있는 날(대부분)은 예전과 같은 달이 나온다 — 이미 적립된 이월의 근거 달은 바뀌지 않는다.
 * @param datesOfMonth 그 반 요일의 그 달 수업일 목록(연간 일정 함수)
 */
export function billingMonthOfDate(dateYmd: string, datesOfMonth: (month: string) => readonly string[]): string {
  const calendarMonth = dateYmd.slice(0, 7);
  return [calendarMonth, addMonthsYm(calendarMonth, 1), addMonthsYm(calendarMonth, -1)]
    .find((month) => month && datesOfMonth(month).includes(dateYmd)) ?? calendarMonth;
}
/** 결석별 반올림을 피하기 위해 분수로 합산하고 마지막 합계에서 한 번 반올림한다. */
export function roundCarryTotal(values: readonly { numerator: string; denominator: string }[]): number {
  let n = BigInt(0), d = BigInt(1);
  const gcd = (a: bigint, b: bigint): bigint => b ? gcd(b, a % b) : a;
  for (const value of values) {
    const a = BigInt(value.numerator), b = BigInt(value.denominator);
    if (a < BigInt(0) || b <= BigInt(0)) throw new WorkbenchError("이월 근거를 확인해 주세요.");
    n = n * b + a * d; d *= b;
    const g = gcd(n, d); n /= g; d /= g;
  }
  const result = Number((n * BigInt(2) + d) / (d * BigInt(2)));
  if (!Number.isSafeInteger(result) || result > WORKBENCH_MAX_AMOUNT) throw new WorkbenchError("이월 합계를 확인해 주세요.");
  return result;
}
export type CarryFraction = { numerator: string; denominator: string };
export type CarrySource = CarryFraction & { id:string; availableMonth:string; valid?:boolean };
export type CarryAllocation = CarryFraction & { creditId:string };
export type CarryUsageBasis = { allocations:CarryAllocation[]; before:CarryFraction; after:CarryFraction; amount:number; sources:CarrySource[]; previousUsageAmounts:number[] };
type FractionPair = { n:bigint; d:bigint };
const fractionGcd=(a:bigint,b:bigint):bigint=>b?fractionGcd(b,a%b):a<BigInt(0)?-a:a;
const fraction=(v:CarryFraction):FractionPair=>{const n=BigInt(v.numerator),d=BigInt(v.denominator);if(d<=BigInt(0))throw new WorkbenchError("이월 분모를 확인해 주세요.");return{n,d};};
const simplify=(p:FractionPair):FractionPair=>{const g=fractionGcd(p.n,p.d);return{n:p.n/g,d:p.d/g};};
const plus=(a:FractionPair,b:FractionPair)=>simplify({n:a.n*b.d+b.n*a.d,d:a.d*b.d});
const minus=(a:FractionPair,b:FractionPair)=>plus(a,{n:-b.n,d:b.d});
const serialize=(p:FractionPair):CarryFraction=>({numerator:String(p.n),denominator:String(p.d)});
/** 실제 소진은 원적립 ID별 분수로 추적한다. 미래 적립으로 앞 기간의 잔액을 부풀리지 않는다. */
export function carryPool(sources:readonly CarrySource[],usages:readonly {amount:number;basis?:unknown}[],month:string) {
  const balances=new Map(sources.map(s=>[s.id,fraction(s)]));let unresolved=false;
  for(const usage of usages) {
    const b=usage.basis as Partial<CarryUsageBasis>|null;
    if(!b || !Array.isArray(b.allocations)){unresolved=true;continue;}
    let allocated:FractionPair={n:BigInt(0),d:BigInt(1)};
    for(const a of b.allocations) {
      if(!balances.has(a.creditId)){unresolved=true;continue;}
      const value=fraction(a);if(value.n<BigInt(0))throw new WorkbenchError("이월 사용 내역을 확인해 주세요.");
      balances.set(a.creditId,minus(balances.get(a.creditId)!,value));allocated=plus(allocated,value);
    }
    if(allocated.n!==BigInt(usage.amount)*allocated.d)unresolved=true;
  }
  let total:FractionPair={n:BigInt(0),d:BigInt(1)};
  const eligible=sources.filter(s=>s.availableMonth<=month && s.valid!==false).sort((a,b)=>a.availableMonth.localeCompare(b.availableMonth)||a.id.localeCompare(b.id));
  for(const source of eligible)total=plus(total,balances.get(source.id)!);
  const rounded=total.n<=BigInt(0)?0:Number((total.n*BigInt(2)+total.d)/(total.d*BigInt(2)));
  if(!Number.isSafeInteger(rounded)||rounded>WORKBENCH_MAX_AMOUNT)throw new WorkbenchError("이월 잔액을 확인해 주세요.");
  return{available:unresolved?0:rounded,unresolved,balances,total,eligible};
}
export function allocateCarry(sources:readonly CarrySource[],usages:readonly {amount:number;basis?:unknown}[],month:string,amount:number):{sourceCreditIds:string[];basis:CarryUsageBasis} {
  const pool=carryPool(sources,usages,month);
  if(pool.unresolved || !Number.isSafeInteger(amount)||amount<=0||amount>pool.available)throw new WorkbenchError("이월 사용 연결 또는 잔액을 확인해 주세요.",409);
  let left:FractionPair={n:BigInt(amount),d:BigInt(1)};const allocations:CarryAllocation[]=[];
  for(const source of pool.eligible) {
    const balance=pool.balances.get(source.id)!;if(balance.n<=BigInt(0))continue;
    const part=balance.n*left.d<=left.n*balance.d?balance:left;
    allocations.push({creditId:source.id,...serialize(part)});left=minus(left,part);
    if(left.n===BigInt(0))break;
  }
  // 합계 반올림으로 생긴 1원 미만 차이는 마지막 적립분에 남겨 다음 잔액 합계에서 함께 상계한다.
  if(left.n>BigInt(0)){
    const last=allocations.at(-1);if(!last)throw new WorkbenchError("사용할 이월 근거가 없습니다.",409);
    Object.assign(last,serialize(plus(fraction(last),left)));
  }
  return{sourceCreditIds:allocations.map(a=>a.creditId),basis:{allocations,before:serialize(pool.total),after:serialize(minus(pool.total,{n:BigInt(amount),d:BigInt(1)})),amount,sources:pool.eligible.map(s=>({...s})),previousUsageAmounts:usages.map(u=>u.amount)}};
}
export function validateWorkbenchCommand(input: unknown): WorkbenchCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WorkbenchError("요청 내용을 확인해 주세요.");
  const b = input as Record<string, unknown>;
  const month = validateWorkbenchMonth(b.month);
  if (!["SAVE", "CONFIRM", "ISSUE"].includes(String(b.action)) || typeof b.sourceVersion !== "string" || !/^[a-f0-9]{64}$/.test(b.sourceVersion) || typeof b.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(b.requestId)) throw new WorkbenchError("검토 내용을 다시 조회해 주세요.");
  if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 500) throw new WorkbenchError("처리할 청구를 1~500개 선택해 주세요.");
  const seen = new Set<string>();
  const rows = b.rows.map((r: unknown) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new WorkbenchError("청구 항목을 확인해 주세요.");
    const row = r as WorkbenchEdit;
    if (typeof row.id !== "string" || row.id.length > 300 || seen.has(row.id) || !Number.isSafeInteger(row.expectedVersion) || row.expectedVersion < 0) throw new WorkbenchError("중복 항목 또는 이전 버전이 포함되어 있습니다.");
    seen.add(row.id);
    if (b.action === "SAVE") {
      validateWorkbenchAmounts({ baseAmount: row.baseAmount!, discountAmount: row.discountAmount!, prorationAmount: row.prorationAmount!, carryAmount: row.carryAmount!, shuttleAmount: row.shuttleAmount! });
      if (typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 500) throw new WorkbenchError("검토·수정 사유를 1~500자로 남겨 주세요.");
      if(row.periodStart!==undefined || row.periodEnd!==undefined){if(typeof row.periodStart!=="string"||typeof row.periodEnd!=="string")throw new WorkbenchError("수강 시작일과 종료일을 함께 입력해 주세요.");filterWorkbenchDates([],row.periodStart,row.periodEnd);}
    } else if (Object.keys(row).some(k => !["id", "expectedVersion"].includes(k))) throw new WorkbenchError("확정·발행은 저장된 금액만 사용합니다.");
    if (Object.keys(row).some(k => !["id", "expectedVersion", "reason", "baseAmount", "discountAmount", "prorationAmount", "carryAmount", "shuttleAmount","periodStart","periodEnd"].includes(k))) throw new WorkbenchError("허용되지 않은 청구 항목입니다.");
    return row;
  });
  if (Object.keys(b).some(k => !["action", "month", "sourceVersion", "requestId", "rows"].includes(k))) throw new WorkbenchError("허용되지 않은 요청입니다.");
  return { action: b.action as WorkbenchCommand["action"], month, sourceVersion: b.sourceVersion, requestId: b.requestId, rows };
}

// ── 질병·부상 결석 «미납 청구에서 1회분 빼기»(2026-11-16 원장 결정) ─────────────────────────
// 미납인 달의 하루짜리 질병·부상 결석은 이월(다음 달 차감) 대신 «그 미납 청구 금액»을 1회 값만큼 줄인다.
// 줄인 사실은 새 표 없이 청구 변경 기록(PaymentAuditLog)에 남긴다 — 아래 action 한 가지, metadata.reduceBy 가 줄인 금액.
// 이 값을 읽는 곳(이월 근거·청구 준비·휴원 정산·발행 보류)이 모두 같은 글자를 써야 한다(테스트가 비교).
export const ILLNESS_UNPAID_REDUCE_ACTION = "ILLNESS_ABSENCE_UNPAID_REDUCED";
/**
 * 그 청구에서 질병·부상 결석으로 «이미 줄인 금액 합계»를 내는 SQL 조각(숫자 한 칸).
 * 원래 금액 = 지금 청구 금액 + 이 값. 발행 초안 금액과 견줄 때·한 번 값을 다시 계산할 때 쓴다.
 * @param paymentIdSql 청구 id 를 가리키는 SQL 식(예: `p.id`, `"Payment".id`) — 코드에 적힌 고정 글자만 넘긴다(사용자 입력 금지)
 */
export function illnessReducedSumSql(paymentIdSql: string): string {
  return `(SELECT COALESCE(SUM((illness_cut.metadata->>'reduceBy')::int),0)::int FROM "PaymentAuditLog" illness_cut WHERE illness_cut."paymentId" = ${paymentIdSql} AND illness_cut.action = '${ILLNESS_UNPAID_REDUCE_ACTION}')`;
}
