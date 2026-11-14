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
