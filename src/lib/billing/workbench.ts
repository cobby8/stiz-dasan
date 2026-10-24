import { isKstYmd } from "@/lib/datetime/kst";
/** 청구 검토표의 공통 계약. 화면 입력과 서버의 계산 근거를 분리한다. */
export type WorkbenchAmounts = { baseAmount: number; discountAmount: number; prorationAmount: number; carryAmount: number; shuttleAmount: number };
export type WorkbenchCalendarSnapshot = { kind:"DB"|"DB_AND_ICS"; events:Array<{title:string;date:string;endDate?:string}>; fingerprint:string };
export type WorkbenchRow = WorkbenchAmounts & {
  id: string; studentId: string; studentName: string; classId: string; className: string;
  status: "READY" | "REVIEW" | "EXCLUDED" | "ISSUED";
  totalAmount: number; reviewReasons: string[]; basis: string[]; version: number;
  draftStatus: "DRAFT" | "CONFIRMED" | "ISSUED" | "ZERO" | null; paymentId: string | null;
  periodStart: string | null; periodEnd: string | null; scheduledDates: string[];
  carryAvailable: number; remainingCarry: number;
  dueDate: string;
  blockingReasons: string[];
};
export type WorkbenchAbsence = {
  id: string; studentId: string; studentName: string; classId: string; date: string;
  reason: string; status: string; makeupStatus: string | null; resolution: string | null;
  reviewReasons: string[];
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
