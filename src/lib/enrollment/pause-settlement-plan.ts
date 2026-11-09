/**
 * 휴원 수강료 처리(이월·환불·없음) 계산 — 순수 함수(DB·시계·import 없음. 테스트가 단독으로 실행한다).
 *
 * 원장 결정(2026-11-10 m6): 원장이 휴원을 승인할 때 «이번 휴원으로 생기는 수강료 처리»를 이월·환불·없음 중 고르고,
 * 금액은 자동 계산해 미리 보여 준 뒤 다음 동작(차감 기록·토스 부분 취소·환불 할 일)까지 이어 간다.
 *
 * ■ 금액 기준 = «그 청구 금액 ÷ 그 청구 수강월의 그 반 수업 수 × 빠지는 수업 수»
 *   - 청구 금액: 실제 청구·납부된 금액(형제 할인·주N회 나눔·3회 달 차감이 이미 반영된 값). 정가가 아니다 —
 *     학부모가 «낸 돈»에서 빠지는 수업만큼 돌려줘야 하기 때문이다.
 *   - 수업 수: 연간 일정(getMonthlyClassDates — /annual·청구 준비와 같은 함수)의 그 반 요일 수업일.
 *     원장이 수강월마다 요일당 4회로 맞춰 운영한다(4주 단위). 3회 달은 청구가 이미 정가×3/4 라 ÷3 = 정가÷4 로 같다.
 *   - 결석 이월(billing/workbench-absence.ts: 할인 후 금액 ÷ 그 기간 수업일 수)과 같은 기준이다.
 *   - 빠지는 수업: 휴원 시작일 ≤ 수업일 < 복귀일(복귀일 미정이면 그 청구의 남은 수업 전부).
 *   - 반올림은 청구 한 건마다 한 번(원 단위). 다 빠지면 청구 금액 그대로(1원 오차 없이).
 *   - 같은 청구에서 다른 휴원 처리가 이미 뺀 날은 다시 빼지 않는다(settledDates).
 * ■ 일정에 그 수강월 수업일이 없으면 계산하지 않는다(추측해서 돈을 움직이지 않는다) → problems.
 */

export const SETTLEMENT_MODES = ["CARRY", "REFUND", "NONE"] as const;
export type SettlementMode = (typeof SETTLEMENT_MODES)[number];
export const SETTLEMENT_MODE_LABEL: Record<SettlementMode, string> = { CARRY: "이월", REFUND: "환불", NONE: "없음" };

export function isSettlementMode(value: unknown): value is SettlementMode {
  return typeof value === "string" && (SETTLEMENT_MODES as readonly string[]).includes(value);
}

/**
 * 돈이 어디로 가는가.
 * TOSS = 토스 온라인 카드·간편결제(부분 취소 API 로 바로 환불) · TOSS_VA = 토스 무통장입금(환불 계좌 필요 → 사람이)
 * TOSS_POS = 현장 POS(단말기에서 부분 취소 → 사람이) · RALLYZ = 랠리즈에서 받은/받을 청구(사이트는 읽기 전용 → 사람이)
 * MANUAL = 현금·계좌이체 등 직접 받은 돈(사람이) · SITE = 사이트 미납 청구(금액을 바로 줄인다)
 */
export type SettlementChannel = "TOSS" | "TOSS_VA" | "TOSS_POS" | "RALLYZ" | "MANUAL" | "SITE";

export type PausePaymentInput = {
  paymentId: string;
  year: number;
  month: number;
  /** 지금 청구 금액 */
  amount: number;
  status: string;
  paidProvider: string | null;
  method: string | null;
  /** 랠리즈 장부 사본(method RALLYZ 또는 사본 감사기록) */
  rallyzMirror: boolean;
  /** 이 청구를 덮는 «완료(DONE)» 토스 온라인 거래(없으면 null). method «가상계좌» = 무통장입금 */
  tossTx: { transactionId: string; method: string | null } | null;
  /** 결제가 진행 중(토스 결제창 승인 중·입금 대기·현장 결제 요청 열림) */
  busy: boolean;
  /** 이 청구 수강월의 그 반 수업일(연간 일정) */
  classDates: string[];
  /** 같은 청구에서 다른 휴원 처리가 이미 뺀 날 */
  settledDates: string[];
  /** 다른 처리가 이 미납 청구에서 이미 줄인 금액(회당 단가를 원래 청구 금액으로 계산하려고) */
  priorReduction: number;
};

export type PausePlanLine = {
  paymentId: string;
  /** 청구 수강월 "YYYY-MM" */
  ym: string;
  paid: boolean;
  channel: SettlementChannel;
  /** 단가 계산에 쓴 청구 금액(미납이면 이미 줄인 금액을 더한 원래 금액) */
  billAmount: number;
  totalSessions: number;
  missedDates: string[];
  /** 이 청구에서 빠지는 금액 */
  amount: number;
};

export type PausePlan = {
  pauseFrom: string;
  resumeOn: string | null;
  lines: PausePlanLine[];
  /** 이미 낸 돈에서 빠지는 금액(이월·환불 대상) */
  paidTotal: number;
  /** 아직 안 낸 청구에서 줄일 금액 */
  unpaidTotal: number;
  /** 하나라도 있으면 실행하지 않는다(계산 불가·결제 진행 중) */
  problems: string[];
  /** 이월이 차감될 «다음 청구»를 고를 기준 수강월 — 이 달보다 뒤의 미납 청구에서 뺀다 */
  carryAfterYm: string;
};

const PAID = "PAID";
const UNPAID = new Set(["PENDING", "OVERDUE"]);

const ymOf = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

/** 청구 한 건에서 빠지는 금액. 다 빠지면 그대로, 아니면 (금액 × 빠진 수 ÷ 전체 수)를 원 단위로 한 번 반올림. */
export function pauseLineAmount(billAmount: number, missed: number, total: number): number {
  if (!Number.isSafeInteger(billAmount) || billAmount <= 0) return 0;
  if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(missed) || missed <= 0) return 0;
  if (missed >= total) return billAmount;
  return Math.round((billAmount * missed) / total);
}

/** 받은 돈이 어느 길로 돌아가는가. 모르는 결제 경로는 사람(MANUAL)에게 — 자동으로 돈을 움직이지 않는다. */
export function paidChannel(p: Pick<PausePaymentInput, "paidProvider" | "method" | "rallyzMirror" | "tossTx">): SettlementChannel {
  const provider = String(p.paidProvider ?? "").trim().toUpperCase();
  if (provider === "TOSS" && p.tossTx) return p.tossTx.method === "가상계좌" ? "TOSS_VA" : "TOSS";
  if (provider === "TOSS_POS") return "TOSS_POS";
  if (p.rallyzMirror || String(p.method ?? "").toUpperCase() === "RALLYZ") return "RALLYZ";
  return "MANUAL";
}

export function planPauseSettlement(input: {
  pauseFrom: string;
  resumeOn: string | null;
  payments: PausePaymentInput[];
}): PausePlan {
  const lines: PausePlanLine[] = [];
  const problems: string[] = [];
  const sorted = [...input.payments].sort((a, b) => a.year - b.year || a.month - b.month || a.paymentId.localeCompare(b.paymentId));
  for (const p of sorted) {
    const paid = p.status === PAID;
    if (!paid && !UNPAID.has(p.status)) continue; // 취소·환불된 청구는 빠질 돈이 없다
    const ym = ymOf(p.year, p.month);
    const dates = [...new Set(p.classDates)].sort();
    // 이 청구 기간에 휴원이 닿는지 먼저 본다 — 일정이 없으면 닿는지도 알 수 없다
    if (dates.length === 0) {
      // 휴원 시작 수강월보다 앞선 청구는 일정이 없어도 상관없다(휴원과 무관)
      if (ym >= input.pauseFrom.slice(0, 7)) problems.push(`${ym} 수강월 수업일이 연간 일정에 없어 금액을 계산할 수 없어요.`);
      continue;
    }
    const settled = new Set(p.settledDates);
    const missed = dates.filter((d) => d >= input.pauseFrom && (!input.resumeOn || d < input.resumeOn) && !settled.has(d));
    if (missed.length === 0) continue;
    if (!paid && p.busy) {
      problems.push(`${ym} 청구는 지금 결제가 진행 중이에요. 결제가 끝나거나 취소된 뒤 다시 해 주세요.`);
      continue;
    }
    const billAmount = paid ? p.amount : p.amount + Math.max(0, p.priorReduction);
    // 지금 남은 청구 금액보다 많이 뺄 수는 없다(이미 줄인 미납 청구)
    const amount = Math.min(pauseLineAmount(billAmount, missed.length, dates.length), p.amount);
    if (amount <= 0) continue;
    lines.push({
      paymentId: p.paymentId,
      ym,
      paid,
      channel: paid ? paidChannel(p) : p.rallyzMirror ? "RALLYZ" : "SITE",
      billAmount,
      totalSessions: dates.length,
      missedDates: missed,
      amount,
    });
  }
  const paidTotal = lines.filter((l) => l.paid).reduce((sum, l) => sum + l.amount, 0);
  const unpaidTotal = lines.filter((l) => !l.paid).reduce((sum, l) => sum + l.amount, 0);
  const lastYm = lines.reduce((max, l) => (l.ym > max ? l.ym : max), input.pauseFrom.slice(0, 7));
  return { pauseFrom: input.pauseFrom, resumeOn: input.resumeOn, lines, paidTotal, unpaidTotal, problems, carryAfterYm: lastYm };
}

/** 미리보기 지문 — 원장이 본 금액과 실행 순간 다시 계산한 금액이 같은지 대조한다(서버가 해시해 쓴다). */
export function planFingerprint(requestId: string, plan: PausePlan): string {
  return JSON.stringify({
    requestId,
    pauseFrom: plan.pauseFrom,
    resumeOn: plan.resumeOn,
    lines: plan.lines.map((l) => [l.paymentId, l.ym, l.paid, l.channel, l.billAmount, l.totalSessions, l.missedDates, l.amount]),
    problems: plan.problems,
  });
}

export type SettlementLineKind = "REFUND" | "CARRY_CREDIT" | "UNPAID_REDUCE" | "NONE" | "CARRY_APPLY" | "CARRY_MANUAL";
export type SettlementLineStatus = "DONE" | "TODO" | "REQUESTED" | "FAILED" | "DONE_MANUAL";

export type SettlementLineDraft = {
  paymentId: string;
  kind: SettlementLineKind;
  channel: SettlementChannel;
  amount: number;
  status: SettlementLineStatus;
  missedDates: string[];
};

/**
 * 고른 처리 방식대로 기록할 줄을 만든다.
 * - 미납 청구: 이월·환불이면 사이트 청구 금액을 바로 줄인다(SITE·DONE). 랠리즈 청구면 사람이 랠리즈에서 줄인다(TODO).
 *   «없음»이면 미납 청구도 그대로 둔다(기록만).
 * - 낸 돈: 환불 = 토스 온라인은 부분 취소 요청(REQUESTED → 실행 후 DONE/FAILED), 그 밖은 사람 할 일(TODO).
 *          이월 = 적립(CARRY_CREDIT·DONE) 후 다음 미납 청구에서 차감. 없음 = 기록만(NONE·DONE).
 */
export function settlementLineDrafts(plan: PausePlan, mode: SettlementMode): { lines: SettlementLineDraft[]; carryTotal: number } {
  const lines: SettlementLineDraft[] = [];
  let carryTotal = 0;
  for (const l of plan.lines) {
    const base = { paymentId: l.paymentId, channel: l.channel, amount: l.amount, missedDates: l.missedDates };
    if (mode === "NONE") {
      lines.push({ ...base, kind: "NONE", status: "DONE" });
    } else if (!l.paid) {
      lines.push({ ...base, kind: "UNPAID_REDUCE", status: l.channel === "SITE" ? "DONE" : "TODO" });
    } else if (mode === "REFUND") {
      lines.push({ ...base, kind: "REFUND", status: l.channel === "TOSS" ? "REQUESTED" : "TODO" });
    } else {
      lines.push({ ...base, kind: "CARRY_CREDIT", status: "DONE" });
      carryTotal += l.amount;
    }
  }
  return { lines, carryTotal };
}

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

/** 사람이 해야 할 일 문장(관리자 화면). 할 일이 아니면 null. */
export function settlementTodoText(line: { kind: string; channel: string; amount: number; status: string }): string | null {
  if (line.status === "FAILED") return `토스 부분 취소 ${won(line.amount)} 확인 필요 — 다시 시도하거나 토스 상점관리자에서 직접 취소`;
  if (line.status === "REQUESTED") return `토스 부분 취소 ${won(line.amount)} 결과 확인 중 — 다시 시도로 확인`;
  if (line.status !== "TODO") return null;
  if (line.kind === "UNPAID_REDUCE") return `랠리즈 청구에서 ${won(line.amount)} 감액`;
  if (line.kind === "REFUND") {
    if (line.channel === "TOSS_POS") return `토스 POS 단말기에서 ${won(line.amount)} 부분 취소`;
    if (line.channel === "TOSS_VA") return `무통장입금 건 — 토스 상점관리자에서 ${won(line.amount)} 환불(환불 계좌 필요)`;
    if (line.channel === "RALLYZ") return `랠리즈에서 ${won(line.amount)} 환불`;
    return `현금·계좌로 ${won(line.amount)} 직접 환불`;
  }
  return null;
}

/**
 * 학부모 앱 알림에 붙일 한 줄(원장 결정: «○원 이월/환불 예정» 한 줄). 붙일 것이 없으면 null.
 * 문자에도 쓰일 수 있어 이모지·꺾쇠 따옴표를 넣지 않는다(errors 2026-11-09).
 */
export function settlementNoticeLine(mode: SettlementMode, paidTotal: number, unpaidTotal: number): string | null {
  const parts: string[] = [];
  if (mode === "CARRY" && paidTotal > 0) parts.push(`수강료 ${won(paidTotal)} 이월 예정(다음 청구에서 차감)`);
  if (mode === "REFUND" && paidTotal > 0) parts.push(`수강료 ${won(paidTotal)} 환불 예정`);
  if (mode !== "NONE" && unpaidTotal > 0) parts.push(`미납 청구 ${won(unpaidTotal)} 감액`);
  return parts.length ? parts.join(" · ") : null;
}

/** 관리자 미리보기 근거 문장(청구마다 한 줄). */
export function describePausePlan(plan: PausePlan): string[] {
  return plan.lines.map((l) => {
    const md = l.missedDates.map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`).join("·");
    return `${l.ym} ${l.paid ? "납부" : "미납"} ${won(l.billAmount)} ÷ ${l.totalSessions}회 × ${l.missedDates.length}회(${md}) = ${won(l.amount)}`;
  });
}
