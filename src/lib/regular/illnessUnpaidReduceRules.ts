// 질병·부상 결석 «미납 청구에서 1회분 빼기» 규칙 — 순수 모듈(DB·시계·React 없음. node 테스트가 바로 실행한다).
//
// 원장 결정(2026-11-16): 그 달 수강료가 «미납»인데 아파서 못 나왔으면, 낸 돈이 없으니 이월(다음 달 차감)할 것이 없다.
//   그래서 막지 않고 «그 미납 청구 금액에서 1회 수업 값을 뺀다».
//   예) 11월 미납 100,000원 ÷ 4회 = 1회 25,000원 → 승인하면 청구가 75,000원.
// 납부된 달은 지금까지처럼 이월로 적립한다(이 파일과 무관).
//
// 1회 값 = round(그 달 수강료 ÷ 그 달 수업 횟수). 수강료·횟수는 이월 근거와 «같은 함수»(workbench-absence)가 센다:
//   · 발행 초안이 있는 달 = 초안의 수강료(기본 − 할인 − 기간 조정). 셔틀비·이월 차감은 수강료가 아니라 분자에 넣지 않는다.
//   · 초안이 없는 달    = 지금 청구 금액 + 사이트가 그 청구에서 이미 줄인 금액(= 원래 금액).
// 여기는 그 숫자를 받아 «얼마를 빼고 얼마가 남는가»와 화면 글자만 정한다.

// 화면 글자·정산 기록 사유·«뺀 결석인가» SQL 조각은 illnessCarryRules.ts 에 있다(신청함·학부모 화면이 이미 그 모듈을 쓴다).
// 이 파일은 import 가 없다 — 숫자와 판정만.

/** 화면이 본 방식·금액과 서버가 다시 읽은 것이 다를 때 */
export const APPROVAL_CHANGED_MESSAGE = "화면에서 본 내용과 지금 청구 상태가 달라요. 내용을 다시 확인한 뒤 승인해 주세요.";
/** 줄이려는 순간 청구가 바뀌어 있었다(금액·납부 상태) */
export const UNPAID_REDUCE_CONFLICT_MESSAGE = "처리하는 사이 청구가 바뀌었어요. 새로고침한 뒤 다시 확인해 주세요.";

/** 미납 청구가 있어도 줄일 수 없는 이유(화면에 그대로 보인다) */
export const UNPAID_REDUCE_BLOCKERS = {
  NOT_UNPAID: "그 달 청구가 더 이상 미납이 아니에요. 새로고침한 뒤 다시 확인해 주세요.",
  RALLYZ: "랠리즈에서 넘어온 청구라 사이트에서 금액을 줄일 수 없어요. 그 청구를 먼저 확인해 주세요.",
  CHECKOUT: "학부모가 결제하는 중이에요. 결제가 끝난 뒤 다시 확인해 주세요.",
  POS: "현장 결제 요청 중인 청구예요. 요청이 끝난 뒤 다시 확인해 주세요.",
  PAID_TX: "결제 거래 기록이 있는 청구라 금액을 줄일 수 없어요. 납부 상태를 먼저 확인해 주세요.",
  NOTHING: "그 청구에서 뺄 금액이 없어요. 청구 금액을 확인해 주세요.",
  // 이월을 쓴 청구·이월의 근거인 청구가 0원(취소)이 되면 그 이월이 풀리거나 무효가 된다 — 자동으로 하지 않고 원장이 직접 본다
  CARRY_LINKED_ZERO: "이월과 묶인 청구라 0원으로 줄일 수 없어요. 그 청구를 먼저 확인해 주세요.",
  BAD_AMOUNT: "청구 금액이나 수업 횟수를 확인할 수 없어 계산하지 못했어요.",
} as const;
export type UnpaidReduceBlockCode = keyof typeof UNPAID_REDUCE_BLOCKERS;

/**
 * 줄일 청구의 상태로 «막아야 하는가»를 정한다. 막을 이유가 없으면 null.
 * 순서: 미납 아님 → 랠리즈 사본 → 학부모 결제 진행 중 → 현장 결제 요청 중 → 결제 거래 있음
 * (부상 기간 결석의 «발행 보류» 건너뛰기 판정과 같은 순서 — 진행 중인 결제를 먼저 알린다)
 */
export function unpaidReduceBlockCode(bill: {
  status: string; rallyzMirror: boolean; checkoutActive: boolean; posBusy: boolean; paidTx: boolean;
}): UnpaidReduceBlockCode | null {
  if (bill.status !== "PENDING" && bill.status !== "OVERDUE") return "NOT_UNPAID";
  if (bill.rallyzMirror) return "RALLYZ";
  if (bill.checkoutActive) return "CHECKOUT";
  if (bill.posBusy) return "POS";
  if (bill.paidTx) return "PAID_TX";
  return null;
}

export type UnpaidReduceAmounts =
  | { ok: true; unit: number; reduceBy: number; before: number; after: number; cancels: boolean }
  | { ok: false; code: UnpaidReduceBlockCode };

/**
 * 얼마를 빼고 얼마가 남는가.
 *   unit     = round(그 달 수강료 ÷ 수업 횟수)
 *   reduceBy = unit 과 지금 청구 금액 중 작은 값(청구가 음수가 되지 않게 — 이월을 이미 쓴 청구처럼 남은 금액이 1회 값보다 작을 때)
 *   after    = 지금 청구 금액 − reduceBy. 0 이면 청구·청구서를 취소 상태로 둔다(cancels)
 *   단, 이월과 묶인 청구(carryLinked)는 0원으로 만들지 않는다 — 취소되면 쓴 이월이 풀려 다음 달에 다시 쓰이거나(이중 보상),
 *   그 청구를 근거로 적립한 이월이 무효가 되어 그 학생의 청구 준비가 막힌다.
 */
export function planUnpaidReduce(input: {
  tuition: number; sessions: number; paymentAmount: number;
  /** 이 청구에 이월을 썼거나, 이 청구를 근거로 적립한 이월이 있다 — 0원(취소)이 되는 감액은 막는다 */
  carryLinked?: boolean;
}): UnpaidReduceAmounts {
  const { tuition, sessions, paymentAmount } = input;
  if (!Number.isSafeInteger(tuition) || tuition < 0 || !Number.isSafeInteger(sessions) || sessions < 1
    || !Number.isSafeInteger(paymentAmount) || paymentAmount < 0) return { ok: false, code: "BAD_AMOUNT" };
  const unit = Math.round(tuition / sessions);
  let reduceBy = Math.min(unit, paymentAmount);
  if (reduceBy <= 0) return { ok: false, code: "NOTHING" };
  // 반올림 찌꺼기 정리: 남는 금액이 «수업 횟수(원)»보다 작으면 나눗셈 반올림으로 생긴 몇 원이다 — 함께 뺀다.
  // (예: 100,000원 ÷ 3회 = 33,333원을 세 번 빼면 1원이 남는다. 1원짜리 미납 청구가 학부모 화면에 남지 않게)
  if (paymentAmount - reduceBy > 0 && paymentAmount - reduceBy < sessions) reduceBy = paymentAmount;
  const after = paymentAmount - reduceBy;
  if (after === 0 && input.carryLinked) return { ok: false, code: "CARRY_LINKED_ZERO" };
  return { ok: true, unit, reduceBy, before: paymentAmount, after, cancels: after === 0 };
}

/** 화면이 승인 버튼과 함께 보내는 «내가 본 것» — 서버가 다시 읽은 것과 다르면 승인하지 않는다 */
export type ApprovalExpectation = { mode: "CARRY" | "REDUCE"; reduceBy?: number | null; after?: number | null };

/** 화면이 보낸 값을 안전한 모양으로(모르는 모양이면 null) */
export function parseApprovalExpectation(value: unknown): ApprovalExpectation | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.mode !== "CARRY" && raw.mode !== "REDUCE") return null;
  const amount = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
  return raw.mode === "REDUCE" ? { mode: "REDUCE", reduceBy: amount(raw.reduceBy), after: amount(raw.after) } : { mode: "CARRY" };
}

/**
 * 화면이 본 것과 서버가 정한 것이 같은가. 다르면 true(승인하지 않는다).
 *   · 이월로 처리될 결석: 화면이 «청구에서 빼기»를 봤으면 다르다. 아무것도 안 보냈으면(예전 화면) 그대로 승인한다 — 기존 동작.
 *   · 청구에서 뺄 결석: 화면이 «청구에서 빼기»를 봤어야 한다(안 보냈거나 이월로 봤으면 다르다).
 *     금액을 볼 수 없는 역할(부원장)은 금액 없이 방식만 보낸다 — 그때는 방식만 견준다.
 */
export function approvalExpectationMismatch(
  expected: ApprovalExpectation | null | undefined,
  actual: { mode: "CARRY" } | { mode: "REDUCE"; reduceBy: number; after: number },
): boolean {
  if (actual.mode === "CARRY") return expected?.mode === "REDUCE";
  if (!expected || expected.mode !== "REDUCE") return true;
  if (typeof expected.reduceBy === "number" && expected.reduceBy !== actual.reduceBy) return true;
  if (typeof expected.after === "number" && expected.after !== actual.after) return true;
  return false;
}

/** 신청함 근거 한 줄에 쓰는 자료. 금액 칸은 금액을 볼 수 없는 역할이면 서버가 null 로 지운다 */
export type UnpaidReduceView = {
  /** 수강월 «YYYY-MM» */
  month: string;
  /** 그 달 수강료(1회 값의 분자) */
  tuition: number | null;
  sessions: number;
  unit: number | null;
  /** 지금 청구 금액 */
  before: number | null;
  reduceBy: number | null;
  /** 승인하면 청구가 되는 금액 */
  after: number | null;
  warnings: string[];
};

const won = (value: number) => `${value.toLocaleString("ko-KR")}원`;

/**
 * 신청함 근거 한 줄.
 *   «근거: 11월 미납 청구 100,000원 ÷ 4회 = 1회 25,000원 · 승인하면 청구가 75,000원이 돼요»
 * 청구 금액이 수강료와 다르면(셔틀비 포함·이월 차감 등) 수강료와 청구 금액을 따로 적는다.
 * 금액이 없으면(부원장) 횟수와 일어나는 일만.
 */
export function unpaidReduceEvidenceLine(view: UnpaidReduceView): string {
  const monthLabel = `${Number(view.month.slice(5, 7))}월`;
  if (view.tuition === null || view.unit === null || view.before === null || view.reduceBy === null || view.after === null) {
    return `근거: ${monthLabel} 미납 청구 ÷ ${view.sessions}회 · 승인하면 그 청구에서 1회분을 빼요`;
  }
  const result = view.after === 0 ? "승인하면 청구가 0원이 되어 취소돼요" : `승인하면 청구가 ${won(view.after)}이 돼요`;
  if (view.tuition === view.before && view.reduceBy === view.unit) {
    return `근거: ${monthLabel} 미납 청구 ${won(view.tuition)} ÷ ${view.sessions}회 = 1회 ${won(view.unit)} · ${result}`;
  }
  // 청구 금액 ≠ 수강료, 또는 남은 청구가 1회 값보다 작아 남은 만큼만 빼는 경우 — 숫자를 풀어서 보인다
  const cut = view.reduceBy === view.unit ? "" : ` · 남은 청구가 작아 ${won(view.reduceBy)}만 빼요`;
  return `근거: ${monthLabel} 미납 수강료 ${won(view.tuition)} ÷ ${view.sessions}회 = 1회 ${won(view.unit)} · 지금 청구 ${won(view.before)}${cut} · ${result}`;
}

/** 금액을 볼 수 없는 역할에게 내려보낼 모양 — 금액 칸을 전부 지운다(횟수·경고 글은 그대로) */
export function maskUnpaidReduceView(view: UnpaidReduceView): UnpaidReduceView {
  return { ...view, tuition: null, unit: null, before: null, reduceBy: null, after: null };
}
