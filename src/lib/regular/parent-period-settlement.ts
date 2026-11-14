// 학부모 «복귀했어요» — 학원이 등록한 질병·부상 기간 닫기 + 예정 이월 금액(2026-11-15 원장 결정 H). 학부모 API 가 부르는 얇은 연결부.
//
// 왜 따로 두나: 계산·읽기는 원장 미리보기와 같은 함수(illness-period-settlement)다. 그 함수는 청구 준비 쪽 모듈을 끌고 오므로,
// 결석 알리기 화면이 늘 쓰는 parent-absence-period.ts 에 섞지 않고 «금액을 물을 때만» 이 파일을 지난다.
import { childAccessSql } from "@/lib/account/child-access";
import { isKstYmd, todayKst } from "@/lib/datetime/kst";
import { prisma } from "@/lib/prisma";
import { lockCompensation } from "@/lib/billing/absence-compensation-guard";
import { notMergedStudent } from "@/lib/studentVisibility";
import { absencePeriodContext, ABSENCE_PERIOD_TX_OPTIONS } from "@/lib/regular/absence-period-runner";
import { endAbsencePeriodInTx, periodCarryColumnsReady } from "@/lib/regular/absence-period-service";
import { ILLNESS_REASON } from "@/lib/regular/illnessCarryRules";
import { ILLNESS_PERIOD_INBOX_HREF, IllnessPeriodError } from "@/lib/regular/illnessPeriodRules";
import { previewParentIllnessSettlement, type ParentSettlementPreview } from "@/lib/regular/illness-period-settlement";
import { settlementContext } from "@/lib/regular/illness-period-settlement-runner";
import { parentAbsencePeriodAvailable } from "@/lib/regular/parent-absence-period";
import { parentReturnDateMax } from "@/lib/regular/parentAbsencePeriodRules";

/**
 * «복귀했어요»(복귀일 선택)를 누르면 보는 예정 이월 금액 — 원장 미리보기와 같은 읽기·같은 계산.
 * 내 아이의 기간만(없거나 남의 아이면 PERIOD_NOT_FOUND). 금액은 서버에서만 만든다(화면이 보낸 금액을 받지 않는다).
 * 근거를 정할 수 없는 달이 있으면 view.pendingCheck=true — 화면이 금액 대신 «학원에서 확인한 뒤 알려 드려요»를 보인다.
 */
export async function previewParentPeriodSettlement(
  parentUserId: string, input: { periodId?: string; returnDate?: string | null },
): Promise<ParentSettlementPreview> {
  if (!(await parentAbsencePeriodAvailable())) throw new Error("PERIOD_NOT_READY");
  const periodId = String(input?.periodId ?? "").trim();
  if (!periodId) throw new Error("PERIOD_NOT_FOUND");
  const returnDate = input?.returnDate ? String(input.returnDate).trim() : null;
  if (returnDate && !isKstYmd(returnDate)) throw new Error("PERIOD_INVALID_DATE");
  // 복귀일은 오늘부터(«복귀했어요»와 같은 규칙)
  if (returnDate && returnDate < todayKst()) throw new Error("PERIOD_RETURN_PAST");
  try {
    const preview = await previewParentIllnessSettlement(
      prisma, { parentUserId, periodId, returnDate }, await settlementContext(parentUserId), await childAccessSql("s", "$1"),
    );
    if (!preview) throw new Error("PERIOD_NOT_FOUND");
    return preview;
  } catch (error) {
    // 날짜 규칙 위반(시작일 전·정해진 복귀일보다 뒤)은 날짜를 다시 고르게 한다
    if (error instanceof IllnessPeriodError) throw new Error("PERIOD_INVALID_DATE");
    throw error;
  }
}

/**
 * 학원이 등록한 질병·부상 기간을 학부모가 «복귀했어요»로 닫는다(2026-11-15 원장 결정 H) — 기존 관리자 복귀 처리(endAbsencePeriodInTx)를
 * 그대로 쓴다(복귀일 이후 결석 취소 · 기간 ENDED · 정산·보강 예약에 묶인 날은 보호). 내 아이의 기간만(childAccessSql).
 * 복귀일은 오늘부터, 시작일 다음 날 이후, 이미 정해진 복귀일보다 늦을 수 없다. «알림 취소»는 없다(학부모가 알린 기간이 아니다).
 * 학부모가 알린 기간은 closeParentAbsencePeriod 가 다룬다 — API 가 그쪽에서 «찾을 수 없음»일 때만 여기로 온다.
 */
export async function returnAcademyIllnessPeriod(parentUserId: string, input: { periodId?: string; returnDate?: string }) {
  if (!(await parentAbsencePeriodAvailable())) throw new Error("PERIOD_NOT_READY");
  const periodId = String(input?.periodId ?? "").trim();
  if (!periodId) throw new Error("PERIOD_NOT_FOUND");
  const access = await childAccessSql("s", "$1");
  const ctx = await absencePeriodContext(parentUserId);
  // 오늘은 KST 공용 모듈로(가짜 일정 컨텍스트가 오늘을 비워 둘 수 있어 여기서 다시 만든다)
  const todayYmd = todayKst();
  const returnDate = typeof input?.returnDate === "string" ? input.returnDate.trim() : "";
  const outcome = await prisma.$transaction(async (tx) => {
    await lockCompensation(tx);
    const periods = await tx.$queryRawUnsafe<Array<{ id: string; studentId: string; studentName: string; startDate: string; returnDate: string | null; coveredUntil: string | null; status: string; carryState: string | null }>>(
      `SELECT p.id, p."studentId" AS "studentId", s.name AS "studentName",
              to_char(p."startDate",'YYYY-MM-DD') AS "startDate", to_char(p."returnDate",'YYYY-MM-DD') AS "returnDate", p.status,
              to_char(p."coveredUntil",'YYYY-MM-DD') AS "coveredUntil",
              ${(await periodCarryColumnsReady(tx)) ? `p."carryState"` : `NULL::text`} AS "carryState"
         FROM "RegularAbsencePeriod" p
         JOIN "Student" s ON s.id = p."studentId"
        WHERE ${access} AND ${notMergedStudent("s")}
          AND p.id = $2 AND p."reportedByUserId" IS NULL AND p.reason = '${ILLNESS_REASON}'
        FOR UPDATE OF p`,
      parentUserId, periodId,
    );
    const period = periods[0];
    if (!period) throw new Error("PERIOD_NOT_FOUND");
    if (period.status !== "ACTIVE") throw new Error("PERIOD_ALREADY_CLOSED");
    if (!isKstYmd(returnDate)) throw new Error("PERIOD_INVALID_DATE");
    if (returnDate < todayYmd) throw new Error("PERIOD_RETURN_PAST");
    if (returnDate <= period.startDate) throw new Error("PERIOD_RETURN_BEFORE_START");
    if (period.returnDate && returnDate > period.returnDate) throw new Error("PERIOD_RETURN_AFTER_END");
    // 상한(보안 검수): 오늘 + 4주 · 결석을 만들어 둔 끝 다음 날을 넘는 날짜는 받지 않는다 — 먼 미래 날짜로 결석이 한꺼번에 생기고 기간이 굳는 것을 막는다
    if (returnDate > parentReturnDateMax({ todayYmd, storedReturnYmd: period.returnDate, coveredUntilYmd: period.coveredUntil })) throw new Error("PERIOD_INVALID_DATE");
    const done = await endAbsencePeriodInTx(tx, { periodId, returnDate }, { ...ctx, todayYmd });
    return { period, done };
  }, ABSENCE_PERIOD_TX_OPTIONS);

  // 원장·코치·기사에게 복귀를 한 번 알린다(앱 안 알림). 승인된 기간이면 신청함의 «정산 필요»로 이어진다. 실패해도 복귀 처리는 되돌리지 않는다
  let notification = null;
  try {
    const { notifyOperationalStaff } = await import("@/lib/operational-staff-notification");
    notification = await notifyOperationalStaff({
      stableEventKey: `illness-period-return:${periodId}:${returnDate}`,
      eventType: "REGULAR_ABSENCE_CANCELED",
      studentId: outcome.period.studentId,
      type: "ABSENCE",
      title: "부상 결석 복귀 알림",
      message: `${outcome.period.studentName} 학생이 ${returnDate}부터 다시 나옵니다.${outcome.period.carryState === "APPROVED" ? " 신청함에서 이월을 정산해 주세요." : ""}`,
      linkUrl: outcome.period.carryState === "APPROVED" ? ILLNESS_PERIOD_INBOX_HREF : "/admin/absence",
      staffLinkUrl: "/staff",
      includeCoach: true,
      includeDriver: true,
      driverContext: { studentId: outcome.period.studentId, serviceDate: returnDate },
    });
  } catch (error) {
    console.error("[parent-absence-period] 복귀 알림 실패:", error instanceof Error ? error.name : "");
  }
  return {
    ok: true,
    notification,
    outcome: "ENDED" as const,
    canceledCount: outcome.done.counts.cancelled,
    closedByDeadline: 0,
    /** 보강이 예약돼 그대로 둔 날 수 */
    makeupKept: outcome.done.counts.makeup,
  };
}
