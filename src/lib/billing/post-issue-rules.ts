/**
 * «발행 뒤 바뀐 청구» 판정 규칙(2026-11-17 원장 목표 «청구는 보고 승인 버튼만»).
 *
 * ■ 왜 있나
 *   관리자가 퇴원·반 이동을 하면 enrollment-end-cleanup 이 끝난 반의 미납 청구를 «목록만» 보여 주고 고치지 않는다.
 *   그 목록은 그 순간 결과 상자에만 떴다가 사라져, 이미 발행된 청구가 수강 상태와 어긋난 채 남는다.
 *   여기서는 «지금» 어긋난 청구를 매번 다시 찾아 줄마다 제안 하나를 만든다(원장이 승인 버튼만 누르게).
 *
 * ■ 무엇을 제안하나(줄마다 하나)
 *   CANCEL  : 그 반 수강이 청구월 시작 전에 끝났는데 그 달 미납 청구가 있다 → «청구 취소 제안»
 *   PRORATE : 퇴원일이 청구월 중간 → «다닌 회차만큼 X원으로 변경 제안»(발행 기록의 수업일·금액으로만 계산)
 *   DEDUCT  : 반 변경 차액이 마이너스(다음 달에서 빼야 함) → «다음 달 청구에서 N원 차감 제안»(목록만, 자동 적용 없음)
 *   PAID    : 위 상황인데 이미 결제된 청구 → «결제됨 — 환불은 원장이 직접»(목록만, 환불하지 않음)
 *   CHECK   : 위 상황인데 금액을 자동으로 정할 수 없다(결제 진행 중·POS 요청·이월·발행 기록 없음 등) → «확인 필요»
 *
 * ■ 원칙: 의심스러우면 자동 제안을 내지 않고 «확인 필요»로 돌린다(금액이 틀린 채 승인되는 일이 없게).
 *   반 변경(CLASS_CHANGE)이 청구월 «중간»에 일어난 경우는 옛 반 청구를 건드리지 않는다 —
 *   반 변경 차액(proration.ts)이 «옛 반 남은 회차»를 이미 계산하므로 여기서 또 줄이면 두 번 빠진다.
 *
 * DB 를 읽지 않는 순수 함수만 둔다(테스트가 그대로 실행). 학부모 알림·문자 코드는 없다.
 */
import { addMonthsYm, isKstYmd } from "@/lib/datetime/kst";
import { HOLD_SKIP_REASONS, type HoldSkipCode } from "@/lib/regular/illnessPeriodRules";
import type { ProrationResult } from "@/lib/enrollment/proration";

/** 결제·POS·이월 등 이유로 자동 처리하지 않는 청구 — 부상 결석 «발행 보류로 돌리기»와 같은 이유 코드·글자를 쓴다 */
export type PostIssueSkipCode = HoldSkipCode;
export const POST_ISSUE_SKIP_REASONS = HOLD_SKIP_REASONS;

/** 이 날짜(KST 달) 이후 청구월의 «결제됨» 줄·반 변경 차감 줄만 보인다 — 오래된 이력으로 목록이 넘치지 않게 */
export const POST_ISSUE_SINCE_MONTH = "2026-11";

export type PostIssueKind = "CANCEL" | "PRORATE" | "DEDUCT" | "PAID" | "CHECK";

/** 화면 묶음 이름(한 줄 행 앞 배지) */
export const POST_ISSUE_KIND_LABEL: Record<PostIssueKind, string> = {
  CANCEL: "취소 제안",
  PRORATE: "금액 변경 제안",
  DEDUCT: "차감 제안",
  PAID: "결제됨",
  CHECK: "확인 필요",
};

/** 발행 기록(청구 준비 초안)의 금액 칸 — workbench.ts 의 WorkbenchAmounts 와 같은 모양 */
export type IssuedDraftAmounts = { baseAmount: number; discountAmount: number; prorationAmount: number; carryAmount: number; shuttleAmount: number };

export type EndedBillInput = {
  paymentId: string;
  studentId: string;
  studentName: string;
  classId: string;
  className: string;
  year: number;
  month: number;
  /** 지금 청구 금액 */
  amount: number;
  /** PENDING · OVERDUE · PAID */
  status: string;
  /** 그 수강을 끝낸 마지막 반영 기록의 종류 */
  endKind: "WITHDRAW" | "CLASS_CHANGE";
  /** 그 반에 더는 안 나오는 첫날(효력일, KST 달력) — 이 날 이후 수업은 안 듣는다 */
  endYmd: string;
  /** 이 청구를 만든 청구 준비 발행 기록(없으면 null — 손으로 만든 청구·이관 청구) */
  draft: { payload: IssuedDraftAmounts | null; scheduledDates: string[] } | null;
  /** 자동으로 손대면 안 되는 이유(있으면 «확인 필요») */
  skip: PostIssueSkipCode | null;
  /** 청구와 수강 기록이 서로 안 맞는 신호(있으면 «확인 필요», 검수 D-1) — anomalyOf 로 만든다 */
  anomaly?: PostIssueAnomaly | null;
  /** 이 청구를 근거로 이월을 적립했다(결제된 청구가 이미 이월로 처리됨, 검수 D-3) */
  carried?: boolean;
};

/**
 * 청구와 수강 기록이 어긋난 신호(검수 D-1 — 운영 실측: 유한빈 12월 목7 80,000 정상 청구가 «취소 제안»으로 떴다.
 * 원장 결정대로 청구 반을 목6→목7 로 손으로 옮겼는데 수강 기록은 아직 목6 수강 중·목7 끝남이었다).
 * 이런 청구는 «수강이 끝난 반의 청구»처럼 보여도 실제로는 정상일 수 있어 자동 제안을 내지 않는다.
 */
export type PostIssueAnomaly = "CLASS_MOVED" | "MANUAL_EDIT" | "SAME_CLASS_ACTIVE" | "OTHER_CLASS_UNBILLED";
export const POST_ISSUE_ANOMALY_REASONS: Record<PostIssueAnomaly, string> = {
  CLASS_MOVED: "발행 뒤 청구 반이 바뀌었습니다 — 수강 기록과 맞는지 확인해 주세요",
  MANUAL_EDIT: "발행 뒤 손으로 고친 청구입니다 — 수강 기록과 맞는지 확인해 주세요",
  SAME_CLASS_ACTIVE: "같은 반에 다시 수강 중입니다 — 확인해 주세요",
  OTHER_CLASS_UNBILLED: "다른 반 청구가 없습니다 — 반 이동 확인",
};

/**
 * 이상 신호 판정(확실한 것부터).
 * (a) 발행 기록의 반 ≠ 청구의 반 → 발행 뒤 청구 반이 바뀜
 * (b) 발행 기록이 없는데 발행 뒤 손 수정 감사 기록이 있음 → 손으로 고친 청구
 * (c) 같은 학생이 같은 반에 지금 수강 중(퇴원 뒤 재등록)
 * (d) 그 달 다른 반을 수강 중인데 그 반 청구가 없음 → 청구 반을 옮겼을 수 있다(반 이동 확인)
 */
export function anomalyOf(input: { draftClassId: string | null; paymentClassId: string; hasDraft: boolean; manualEdited: boolean; sameClassActive: boolean; otherClassUnbilled: boolean }): PostIssueAnomaly | null {
  if (input.hasDraft && input.draftClassId && input.draftClassId !== input.paymentClassId) return "CLASS_MOVED";
  if (!input.hasDraft && input.manualEdited) return "MANUAL_EDIT";
  if (input.sameClassActive) return "SAME_CLASS_ACTIVE";
  if (input.otherClassUnbilled) return "OTHER_CLASS_UNBILLED";
  return null;
}

export type PostIssueItem = {
  /** 무시 기록·승인 확인에 쓰는 열쇠 — 같은 청구·같은 종료일이면 같은 열쇠(제안 종류가 바뀌어도 «무시»가 유지되게) */
  key: string;
  kind: PostIssueKind;
  /** 승인 가능한 줄인가(CANCEL·PRORATE 만) */
  approvable: boolean;
  studentId: string;
  studentName: string;
  className: string;
  /** «2026년 12월» 같은 청구월(반 변경 줄은 변경 달) */
  monthLabel: string;
  paymentId: string | null;
  requestId: string | null;
  /** 지금 청구 금액(반 변경 줄은 null) */
  currentAmount: number | null;
  /** 제안 금액 — 취소는 0, 변경은 새 금액, 차감은 뺄 금액 */
  proposedAmount: number | null;
  /** 한 줄 설명(무엇을·왜) */
  text: string;
};

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
const ymOf = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;
export const monthLabelOf = (year: number, month: number) => `${year}년 ${month}월`;
/**
 * 줄 열쇠 = «대상:종료일:제안 종류»(검수 D-4). 종류가 들어 있어 «확인 필요»(결제 진행 중 같은 일시 사유)를 무시해도
 * 나중에 승인할 수 있는 취소 제안으로 바뀌면 새 줄로 다시 뜬다.
 * 승인 기록은 종류를 뗀 «바탕 열쇠»(baseKeyOf)로 거른다 — 금액을 바꾼 뒤 «확인 필요»로 다시 뜨지 않게.
 */
export const billKey = (paymentId: string, endYmd: string, kind: PostIssueKind) => `P:${paymentId}:${endYmd}:${kind}`;
export const requestKey = (requestId: string, kind: PostIssueKind) => `R:${requestId}:${kind}`;
/** 열쇠에서 제안 종류를 뗀 바탕 열쇠 */
export const baseKeyOf = (key: string) => key.replace(/:(CANCEL|PRORATE|DEDUCT|PAID|CHECK)$/, "");

const validAmounts = (p: IssuedDraftAmounts | null | undefined): p is IssuedDraftAmounts =>
  Boolean(p) && (["baseAmount", "discountAmount", "prorationAmount", "carryAmount", "shuttleAmount"] as const)
    .every((k) => Number.isSafeInteger(p![k]) && p![k] >= 0);

/**
 * 퇴원일이 청구월 중간인 청구를 «다닌 회차만큼»으로 줄인 금액.
 * 수강료(할인·기간 조정 뒤) = 발행 때 수강료 × 다닌 회차 ÷ 발행 때 수업 회차(한 번 반올림). 셔틀비는 그대로 둔다(줄인다는 규칙이 없다).
 * 계산할 수 없으면 사유 글자(문자열)를 돌려준다 → «확인 필요».
 *   - 발행 기록이 없거나 금액 칸이 이상함 · 이월 차감이 들어 있음(이월을 어떻게 나눌지 규칙 없음)
 *   - 지금 청구 금액이 발행 때 금액과 다름(그 뒤 손으로 고쳤다 — 무엇을 기준으로 줄일지 모른다)
 *   - 발행 때 수업일 사본이 없음
 * 줄일 것이 없으면(퇴원일이 마지막 수업 뒤) null.
 */
export function prorateWithdrawnBill(input: { amount: number; endYmd: string; draft: EndedBillInput["draft"] }):
  { kind: "CANCEL" } | { kind: "PRORATE"; amount: number; attended: number; covered: number; shuttle: number } | { kind: "CHECK"; reason: string } | null {
  const draft = input.draft;
  if (!draft || !validAmounts(draft.payload)) return { kind: "CHECK", reason: "청구 준비 발행 기록이 없어 다닌 회차로 나눌 수 없습니다" };
  const p = draft.payload;
  if (p.carryAmount > 0) return { kind: "CHECK", reason: "이월 차감이 들어간 청구라 자동으로 나누지 않습니다" };
  const issuedTotal = p.baseAmount - p.discountAmount - p.prorationAmount - p.carryAmount + p.shuttleAmount;
  if (issuedTotal !== input.amount) return { kind: "CHECK", reason: "발행 뒤 금액이 바뀐 청구라 자동으로 나누지 않습니다" };
  const dates = [...new Set(draft.scheduledDates.filter((d) => isKstYmd(d)))].sort();
  if (!dates.length) return { kind: "CHECK", reason: "발행 때 수업일 기록이 없어 다닌 회차를 셀 수 없습니다" };
  const attended = dates.filter((d) => d < input.endYmd).length;
  if (attended === dates.length) return null; // 마지막 수업 뒤에 퇴원 — 그 달은 다 다녔다
  if (attended === 0) return { kind: "CANCEL" }; // 그 달 수업을 하나도 안 들었다
  const tuition = p.baseAmount - p.discountAmount - p.prorationAmount;
  if (tuition <= 0) return { kind: "CHECK", reason: "수강료가 0원 이하인 청구라 자동으로 나누지 않습니다" };
  const next = Math.round(tuition * attended / dates.length) + p.shuttleAmount;
  if (next >= input.amount) return null;
  return { kind: "PRORATE", amount: next, attended, covered: dates.length, shuttle: p.shuttleAmount };
}

/**
 * 끝난 반의 청구 한 줄을 판정한다. 어긋남이 없으면 null.
 * - 청구월이 종료일보다 뒤에 끝나는 달만 본다(종료일이 다음 달 1일 이후면 그 달은 다 다녔다).
 * - 종료일 ≤ 청구월 1일 → 취소. 청구월 중간 → 퇴원만 다닌 회차로 줄이기(반 변경은 차액이 처리 — 건드리지 않음).
 */
export function decideEndedBill(input: EndedBillInput): PostIssueItem | null {
  if (!isKstYmd(input.endYmd) || !Number.isInteger(input.year) || !Number.isInteger(input.month) || input.month < 1 || input.month > 12) return null;
  const ym = ymOf(input.year, input.month);
  const monthStart = `${ym}-01`;
  const nextMonthStart = `${addMonthsYm(ym, 1)}-01`;
  if (input.endYmd >= nextMonthStart) return null; // 그 달이 끝난 뒤에 그만뒀다
  const whole = input.endYmd <= monthStart;
  if (!whole && input.endKind === "CLASS_CHANGE") return null; // 반 변경 달 — 차액 계산이 맡는다
  const base = {
    studentId: input.studentId, studentName: input.studentName, className: input.className,
    monthLabel: monthLabelOf(input.year, input.month), paymentId: input.paymentId, requestId: null, currentAmount: input.amount,
  };
  const endText = input.endKind === "CLASS_CHANGE" ? `반 이동(${input.endYmd}부터 다른 반)` : `수강 종료(${input.endYmd}부터)`;

  const make = (kind: PostIssueKind, rest: Pick<PostIssueItem, "approvable" | "proposedAmount" | "text">): PostIssueItem =>
    ({ ...base, key: billKey(input.paymentId, input.endYmd, kind), kind, ...rest });
  const check = (text: string) => make("CHECK", { approvable: false, proposedAmount: null, text });

  // 이미 결제된 청구 — 환불은 하지 않는다(원장이 직접). 목록에만 보인다.
  if (input.status === "PAID") {
    if (ym < POST_ISSUE_SINCE_MONTH) return null;
    // 이미 이월로 처리된 결제 청구는 할 일이 끝났다 — 목록에서 숨긴다(검수 D-3)
    if (input.carried) return null;
    const plan = whole ? { kind: "CANCEL" as const } : prorateWithdrawnBill(input);
    if (!plan) return null;
    return make("PAID", { approvable: false, proposedAmount: null, text: `${endText} 뒤 청구가 이미 결제됨 — 환불은 원장이 직접 판단해 주세요` });
  }
  if (input.status !== "PENDING" && input.status !== "OVERDUE") return null;
  // 청구와 수강 기록이 서로 안 맞으면(청구 반을 옮김·손 수정·재등록·다른 반 청구 없음) 자동 제안을 내지 않는다(검수 D-1)
  if (input.anomaly) return check(`${endText} 뒤 남은 청구로 보이지만 ${POST_ISSUE_ANOMALY_REASONS[input.anomaly]}`);

  const plan = whole ? { kind: "CANCEL" as const } : prorateWithdrawnBill(input);
  if (!plan) return null;
  if (plan.kind === "CHECK") return check(`${endText} — 그 달 일부만 다님. ${plan.reason}`);
  // 결제 진행 중·POS 요청·이월 근거 등 — 제안 내용은 보여 주되 승인은 막는다
  const suggestion = plan.kind === "CANCEL" ? "청구 취소" : `${won(plan.amount)}으로 변경`;
  if (input.skip) return check(`${endText} — ${suggestion} 대상이지만 ${POST_ISSUE_SKIP_REASONS[input.skip]}`);
  if (plan.kind === "CANCEL") {
    return make("CANCEL", { approvable: true, proposedAmount: 0, text: `${endText} — 그 달 수업이 없어 ${won(input.amount)} 청구 취소 제안` });
  }
  const shuttleNote = plan.shuttle > 0 ? ` · 셔틀비 ${won(plan.shuttle)}은 그대로` : "";
  return make("PRORATE", { approvable: true, proposedAmount: plan.amount,
    text: `${endText} — ${plan.covered}회 중 ${plan.attended}회 다님 → ${won(input.amount)}에서 ${won(plan.amount)}으로 변경 제안${shuttleNote}` });
}

export type ClassChangeInput = {
  requestId: string;
  studentId: string;
  studentName: string;
  fromClassName: string;
  toClassName: string;
  effectiveFrom: string;
  /** proration.ts computeClassChangeProration 결과(계산하지 못했으면 null — 이유는 problem) */
  proration: ProrationResult | null;
  /** 계산하지 못한 이유(검수 D-2 — 옛 반이 보관 처리돼 요일이 없는데 «계획표에 수업일 없음»이라고 하던 문제) */
  problem?: ClassChangeProblem | null;
};

export type ClassChangeProblem = "CALENDAR_UNREAD" | "FROM_DAY_UNKNOWN" | "TO_DAY_UNKNOWN" | "NO_SCHEDULE";
export const CLASS_CHANGE_PROBLEM_TEXT: Record<ClassChangeProblem, string> = {
  CALENDAR_UNREAD: "연간 일정을 읽지 못해 차액을 계산하지 못했습니다",
  FROM_DAY_UNKNOWN: "옛 반의 수업 요일을 알 수 없어(보관 처리된 반 등) 차액을 계산하지 못했습니다",
  TO_DAY_UNKNOWN: "새 반의 수업 요일을 알 수 없어(보관 처리된 반 등) 차액을 계산하지 못했습니다",
  NO_SCHEDULE: "연간 계획표에 그달 수업일이 없어 차액을 계산하지 못했습니다",
};
const WEEKDAYS = new Set(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
/** 반 변경 차액을 계산할 수 있는가 — 못 하면 이유(달력 못 읽음 → 옛 반 요일 → 새 반 요일 순) */
export function classChangeProblemOf(input: { calendarRead: boolean; fromDay: string | null; toDay: string | null }): ClassChangeProblem | null {
  if (!input.calendarRead) return "CALENDAR_UNREAD";
  if (!input.fromDay || !WEEKDAYS.has(input.fromDay)) return "FROM_DAY_UNKNOWN";
  if (!input.toDay || !WEEKDAYS.has(input.toDay)) return "TO_DAY_UNKNOWN";
  return null;
}

/**
 * 반 변경 차액이 마이너스인 줄(다음 달 청구에서 빼야 함) — 목록만 보인다(자동 적용 금지).
 * 차액이 0 이상이거나 달 1일 변경(일할 없음)이면 null. 계획표가 없어 계산 못 하면 «확인 필요».
 */
export function decideClassChange(input: ClassChangeInput): PostIssueItem | null {
  if (!isKstYmd(input.effectiveFrom) || input.effectiveFrom.slice(0, 7) < POST_ISSUE_SINCE_MONTH) return null;
  if (input.effectiveFrom.endsWith("-01")) return null;
  const [y, m] = input.effectiveFrom.split("-").map(Number);
  const base = {
    studentId: input.studentId, studentName: input.studentName,
    className: `${input.fromClassName} → ${input.toClassName}`, monthLabel: monthLabelOf(y, m),
    paymentId: null, requestId: input.requestId, currentAmount: null, approvable: false,
  };
  const p = input.proration;
  if (!p || p.scheduleUnavailable) {
    const problem: ClassChangeProblem = input.problem ?? "NO_SCHEDULE";
    return { ...base, key: requestKey(input.requestId, "CHECK"), kind: "CHECK", proposedAmount: null, text: `반 변경(${input.effectiveFrom}) — ${CLASS_CHANGE_PROBLEM_TEXT[problem]}` };
  }
  if (!p.needsProration || p.diff >= 0) return null;
  const nextMonth = addMonthsYm(input.effectiveFrom.slice(0, 7), 1);
  return { ...base, key: requestKey(input.requestId, "DEDUCT"), kind: "DEDUCT", proposedAmount: -p.diff,
    text: `반 변경(${input.effectiveFrom}) 차액 −${won(-p.diff)} — ${Number(nextMonth.slice(5, 7))}월 청구에서 ${won(-p.diff)} 차감 제안(직접 반영해 주세요)` };
}

/** 화면 정렬: 승인할 수 있는 줄 → 확인 필요 → 목록만(결제됨·차감) / 같은 묶음은 학생 이름순 */
export function sortPostIssueItems(items: PostIssueItem[]): PostIssueItem[] {
  const rank: Record<PostIssueKind, number> = { CANCEL: 0, PRORATE: 0, CHECK: 1, DEDUCT: 2, PAID: 2 };
  return [...items].sort((a, b) => rank[a.kind] - rank[b.kind] || a.studentName.localeCompare(b.studentName, "ko") || a.key.localeCompare(b.key));
}

/** 승인 요청에서 화면이 본 제안과 서버가 지금 다시 계산한 제안이 같은가(다르면 아무것도 하지 않는다) */
export function sameProposal(seen: { key: string; kind: string; currentAmount: number | null; proposedAmount: number | null }, now: PostIssueItem | null): boolean {
  return Boolean(now && now.approvable && now.key === seen.key && now.kind === seen.kind
    && now.currentAmount === seen.currentAmount && now.proposedAmount === seen.proposedAmount);
}
