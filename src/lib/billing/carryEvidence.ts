// 결석 이월의 «원기간 근거» 판정 — 순수 계산(DB·시계·외부 호출 없음).
//
// 왜 따로 두나: 이월 한 번 값은 «그 달에 실제로 낸 수강료 ÷ 그 달 수업 횟수»다. 지금까지는 청구 준비에서 발행한
// 초안(BillingWorkbenchDraft)만 근거로 인정해서, 랠리즈에서 넘어온 «납부는 됐지만 초안이 없는» 달은 전부 막혔다.
// 여기서 «어떤 자료를 근거로 삼을지»를 한 곳에서 정한다 — 하루짜리 이월과 기간 정산(3단계)이 같은 규칙을 쓴다.
//
// 근거 우선순위(설계 C):
//   ① 발행 초안(ISSUED/ZERO)이고 그 청구가 납부됨 → 초안 금액(수강료−할인−기간조정), 수업일 = 발행 때 사본
//   ② 그 학생·그 반·그 달의 납부완료(PAID) 수강료 청구 1건 → 청구 금액(+이미 줄인 금액), 수업일 = 연간 일정
//   ③ 그 밖(발행됐지만 미납·청구 전) → 낸 돈이 없는 달(UNPAID) — 이월을 만들지 않는다
//   납부완료가 2건 이상이면 어느 청구가 근거인지 정할 수 없어 차단(BLOCKED)
import type { WorkbenchAmounts } from "./workbench";

export type MonthEvidence =
  | {
      kind: "WORKBENCH_ISSUED" | "PAID_PAYMENT";
      /** 한 번 값의 분자 — 그 달 수강료(할인 후, 이월·셔틀 계산 전) */
      tuition: number;
      /** 한 번 값의 분모가 되는 수업일 */
      scheduledDates: string[];
      paymentId: string | null;
      periodStart: string | null;
      periodEnd: string | null;
      warnings: string[];
    }
  | { kind: "UNPAID"; scheduledDates: string[] }
  | { kind: "BLOCKED"; reason: string };

export type IssuedDraftEvidence = {
  status: "ISSUED" | "ZERO";
  payload: WorkbenchAmounts;
  paymentId: string | null;
  /** 연결된 청구의 상태(ZERO 는 청구가 없어 null) */
  paymentStatus: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  scheduledDates: string[];
};

/** 그 학생·그 반·그 수강월의 type MONTHLY · status PAID 청구만 넘긴다(취소·환불은 근거가 아니다) */
export type PaidPaymentEvidence = {
  id: string;
  /** 지금 청구 금액 */
  amount: number;
  /** 이 청구에서 이미 줄인 금액(휴원 미납 감액·휴원 이월 차감) — 원래 금액 = amount + priorReduction */
  priorReduction: number;
};

export const CARRY_EVIDENCE_MULTIPLE_PAID = "같은 반·같은 달에 납부된 수강료 청구가 여러 건입니다. 어느 청구가 근거인지 직접 확인해 주세요.";
export const CARRY_EVIDENCE_NO_DATES = "그 달 연간 일정의 수업일이 없어 한 번 값을 계산할 수 없습니다.";
export const CARRY_EVIDENCE_NO_PERIOD = "원기간 월중 청구의 실제 수강 기간 근거가 없습니다. 전체 월 회수로 추측 이월할 수 없습니다.";
export const CARRY_EVIDENCE_BAD_AMOUNT = "원기간 청구 금액을 확인해 주세요.";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** 중복을 없애고 날짜순으로 — 분모가 흔들리지 않게 */
const cleanDates = (dates: readonly string[]) => [...new Set(dates.filter((d) => typeof d === "string" && YMD.test(d)))].sort();
const validAmount = (value: number) => Number.isSafeInteger(value) && value >= 0;

export function resolveMonthEvidence(input: {
  issuedDraft: IssuedDraftEvidence | null;
  paidPayments: readonly PaidPaymentEvidence[];
  /** 연간 일정이 정한 그 달 그 반의 수업일(getMonthlyClassDates) */
  monthDates: readonly string[];
  /** 수강 개시일(«YYYY-MM-DD») — 그 달 안이면 수업일을 개시일 이후로 좁힌다 */
  enrollmentStartsOn: string | null;
  /** 그 달 셔틀 명단에 있고 별도 셔틀비 청구가 없다 — 청구 금액에 셔틀비가 섞였을 수 있다(경고만) */
  shuttleMayBeIncluded?: boolean;
}): MonthEvidence {
  const monthDates = cleanDates(input.monthDates);
  const draft = input.issuedDraft;

  // ① 발행 초안 + 납부됨(0원 완료는 청구가 없으므로 그대로 인정 — 금액은 초안 값)
  if (draft && (draft.status === "ZERO" || draft.paymentStatus === "PAID")) {
    const tuition = draft.payload.baseAmount - draft.payload.discountAmount - draft.payload.prorationAmount;
    if (!validAmount(tuition)) return { kind: "BLOCKED", reason: CARRY_EVIDENCE_BAD_AMOUNT };
    const snapshot = cleanDates(draft.scheduledDates ?? []);
    // 기간 조정이 있는데 발행 때 수업일 사본이 없으면 전체 월 횟수로 추측하지 않는다(기존 규칙과 같다)
    if (!snapshot.length && draft.payload.prorationAmount > 0) return { kind: "BLOCKED", reason: CARRY_EVIDENCE_NO_PERIOD };
    const scheduledDates = snapshot.length ? snapshot : monthDates;
    if (!scheduledDates.length) return { kind: "BLOCKED", reason: CARRY_EVIDENCE_NO_DATES };
    return {
      kind: "WORKBENCH_ISSUED", tuition, scheduledDates, paymentId: draft.paymentId,
      periodStart: snapshot.length ? draft.periodStart : null, periodEnd: snapshot.length ? draft.periodEnd : null, warnings: [],
    };
  }

  // ② 납부완료 청구 — 2건 이상이면 근거를 정할 수 없다
  if (input.paidPayments.length > 1) return { kind: "BLOCKED", reason: CARRY_EVIDENCE_MULTIPLE_PAID };
  const paid = input.paidPayments[0];
  if (paid) {
    // 이미 줄인 금액이 있으면 «원래 금액» 기준 — 줄어든 금액으로 나누면 한 번 값이 실제보다 작아진다
    const tuition = paid.amount + Math.max(0, paid.priorReduction);
    if (!validAmount(paid.amount) || !validAmount(tuition)) return { kind: "BLOCKED", reason: CARRY_EVIDENCE_BAD_AMOUNT };
    const warnings: string[] = [];
    let scheduledDates = monthDates, periodStart: string | null = null, periodEnd: string | null = null;
    const startsOn = input.enrollmentStartsOn;
    // 월중 등록: 개시일이 그 달 첫 수업일보다 뒤면 개시일 이후 수업만 센다(문자열 비교 — 시간대 계산 없음)
    if (startsOn && YMD.test(startsOn) && monthDates.length && startsOn.slice(0, 7) === monthDates[0].slice(0, 7) && startsOn > monthDates[0]) {
      scheduledDates = monthDates.filter((d) => d >= startsOn);
      periodStart = startsOn;
      periodEnd = monthDates[monthDates.length - 1];
      warnings.push(`월중 등록(개시일 ${startsOn})이라 개시일 이후 수업 ${scheduledDates.length}회로 나눴어요.`);
    }
    if (!scheduledDates.length) return { kind: "BLOCKED", reason: CARRY_EVIDENCE_NO_DATES };
    if (input.shuttleMayBeIncluded) warnings.push("셔틀비가 포함된 금액일 수 있어요.");
    return { kind: "PAID_PAYMENT", tuition, scheduledDates, paymentId: paid.id, periodStart, periodEnd, warnings };
  }

  // ③ 낸 돈이 없는 달(발행됐지만 미납 · 청구 전)
  const snapshot = cleanDates(draft?.scheduledDates ?? []);
  return { kind: "UNPAID", scheduledDates: snapshot.length ? snapshot : monthDates };
}
