// 부상·질병 «기간 결석» 퇴원 정산(환불 검토) — 화면에 내려보낼 모양을 만드는 순수 모듈(DB·React 없음. node 테스트가 바로 실행한다).
//
// 왜 따로 두나: «금액을 누구에게 내려보내는가»를 한 함수에서 정하고, 그 함수를 테스트가 실제로 돌려 확인하기 위해서다.
// 금액(수강료·한 번 값·소계·합계)과 지문(금액을 넣어 만든 해시)은 금액을 볼 수 있는 역할(원장)에게만 채운다.
// 화면에서만 가리면 개발자도구로 보이므로, 서버 응답에서 아예 뺀다(부원장 금액 숨김 규칙).
import type { IllnessPeriodSettlementView } from "@/app/actions/illness-period-admin";
import { unpaidGuideRefundText, type SettlementRow, type UnpaidGuide } from "@/lib/regular/illnessPeriodSettlementPlan";

/** 퇴원 정산 칸의 단계 — PREVIEW 넘기기 전(표 미리보기) · REVIEW 환불 검토 중 · DONE 환불 처리함 */
export type IllnessPeriodRefundStage = "PREVIEW" | "REVIEW" | "DONE";

/** 복귀 정산 칸과 같은 모양(같은 표 부품이 그린다) + 퇴원 정산에만 있는 칸 */
export type IllnessPeriodRefundView = IllnessPeriodSettlementView & {
  refund: {
    stage: IllnessPeriodRefundStage;
    /** 수납 관리에서 그 학생의 납부 청구를 여는 주소(기존 화면) */
    financeHref: string;
    /** 환불 처리함 메모(DONE 이고 금액을 볼 수 있는 역할일 때만 — 메모에 환불 금액이 적히므로 부원장에게는 내려보내지 않는다) */
    memo: string | null;
  };
};

/** 수납 관리에서 그 학생의 납부 청구가 보이는 기존 화면 주소 */
export function refundFinanceHref(studentId: string): string {
  return `/admin/finance?studentId=${encodeURIComponent(studentId)}`;
}

/**
 * 퇴원 정산 화면 모양을 만든다.
 * @param input.money 금액을 볼 수 있는 역할인가(원장) — 아니면 금액 칸과 지문은 모두 null
 * @param input.total 환불 검토 금액(정산표 합계)
 */
export function buildRefundView(input: {
  stage: IllnessPeriodRefundStage; money: boolean; writesEnabled: boolean; studentId: string;
  rows: readonly SettlementRow[]; total: number; unpaidGuides: readonly UnpaidGuide[];
  fingerprint: string | null; countUntil: string | null; storedReturnDate: string | null;
  blockers: readonly string[]; needsHold: boolean; memo: string | null;
}): IllnessPeriodRefundView {
  const { money } = input;
  return {
    // 넘기기 전 = 넘길 수 있는 표(READY) · 넘긴 뒤 = 그때의 표 사본(SETTLED — 날짜를 더 빼고 넣지 않는다)
    state: input.stage === "PREVIEW" ? "READY" : "SETTLED",
    canSeeMoney: money, canSettle: money, writesEnabled: input.writesEnabled,
    returnDate: input.countUntil, storedReturnDate: input.storedReturnDate,
    // 퇴원한 아이는 복귀일을 받지 않고, 이월이 아니라 «쓸 수 있는 달»도 없다
    canSetReturnDate: false, availableMonth: null,
    // 지문은 금액을 넣어 만든 해시다 — 금액을 못 보는 역할에는 내려보내지 않는다(대입으로 금액을 맞힐 수 있다)
    fingerprint: money && input.stage === "PREVIEW" ? input.fingerprint : null,
    rows: input.rows.map((row) => {
      const paid = row.evidence === "WORKBENCH_ISSUED" || row.evidence === "PAID_PAYMENT";
      return {
        key: `${row.classId}|${row.month}`, month: row.month, className: row.className, evidence: row.evidence, sessions: row.sessions,
        tuition: money && paid ? row.tuition : null, unit: money && paid ? row.unitDisplay : null, subtotal: money && paid ? row.subtotal : null,
        dates: row.dates.map((date, index) => ({ absenceId: row.absenceIds[index], date })),
        excluded: row.excluded.map((item) => ({ absenceId: item.absenceId, date: item.date, code: item.code, why: item.why })),
        warnings: row.warnings ?? [], blockedReason: row.blockedReason ?? null,
      };
    }),
    carryTotal: money ? input.total : null,
    // 낸 돈이 없는 달 — 금액 없는 안내 문구(환불 대상이 아니라는 것만)
    unpaid: input.unpaidGuides.map((guide) => unpaidGuideRefundText(guide)),
    blockers: [...input.blockers], needsHold: input.needsHold, used: false,
    refund: { stage: input.stage, financeHref: refundFinanceHref(input.studentId), // 메모에는 «11/20 카드 취소 84,000원»처럼 금액이 적힌다 — 금액을 못 보는 역할에는 내려보내지 않는다
      memo: money && input.stage === "DONE" ? input.memo : null },
  };
}
