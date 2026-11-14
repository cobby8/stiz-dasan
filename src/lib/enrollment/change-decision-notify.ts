import { prisma } from "@/lib/prisma";
import { childAccessSql } from "@/lib/account/child-access";
import { notMergedStudent } from "@/lib/studentVisibility";
import { deliverOperationalNotification } from "@/lib/operational-notification-delivery";
import { buildChangeDecisionNotice, CHANGE_NOTICE_LINK, type ChangeNoticeEvent } from "@/lib/enrollment/parentChangeStatus";
import { isSettlementMode, settlementNoticeLine } from "@/lib/enrollment/pause-settlement-plan";

// ── 수강 변경 결정·적용 → 신청한 학부모에게 앱 알림 (2026-11-10 원장 결정 d6) ─────────
//
// 왜: 예전엔 결정 알림을 «보류(HELD)»로만 남겨, 학부모는 승인·거절을 «⋯» 메뉴 안 화면에 들어가야만 알았다.
// 무엇: 인앱 알림 + 웹푸시만(운영 알림 전달 장부 = deliverOperationalNotification). 문자·알림톡은 보내지 않는다.
// 누구에게: 신청자(requestedByUserId) 한 명 — 그 사람이 지금도 그 학생의 보호자일 때만.
//   취소 요청(d8) 결과(CANCEL_*)는 취소를 요청한 보호자(cancelRequestedByUserId)에게.
//   관리자가 직접 만든 변경(신청자 = 관리자)·연결이 끊긴 보호자에게는 보내지 않는다.
// 중복: 키 = `enrollment-change:<신청 id>:<APPROVED|REJECTED|APPLIED>` + 받는 사람 → 같은 결정은 한 번만.
// ⚠️ 결정·적용 트랜잭션이 끝난 뒤에 부른다. 알림 실패는 결정을 되돌리지 않는다(기록만 남기고 삼킨다).

export type ChangeNoticeOutcome = "SENT" | "DUPLICATE" | "SKIPPED" | "FAILED";

export async function notifyParentOfEnrollmentChange(requestId: string, event: ChangeNoticeEvent): Promise<ChangeNoticeOutcome> {
  try {
    // 신청 1건 + 학생 이름(병합된 학생이면 빠진다).
    // 반 이름은 신청 당시 반(fromClass) — 승인 시점에 반이 바뀌어 있어도 학부모가 낸 신청 그대로 부른다.
    const rows = await prisma.$queryRawUnsafe<Array<{
      requestedByUserId: string; decidedByUserId: string | null; studentId: string; studentName: string;
      className: string | null; kind: string; effectiveFrom: string; decisionNote: string | null;
    }>>(
      // 반 추가(CLASS_ADD)는 떠나는 반이 없어 fromClass 가 비어 있다 → 추가할 반(toClass) 이름으로 부른다.
      `SELECT r."requestedByUserId", r."decidedByUserId", r."studentId", s.name AS "studentName",
              COALESCE(fc.name, CASE WHEN r.kind = 'CLASS_ADD' THEN tc.name END) AS "className",
              r.kind, to_char(r."effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom", r."decisionNote"
         FROM "EnrollmentChangeRequest" r
         JOIN "Student" s ON s.id = r."studentId" AND ${notMergedStudent("s")}
         LEFT JOIN "Class" fc ON fc.id = r."fromClassId"
         LEFT JOIN "Class" tc ON tc.id = r."toClassId"
        WHERE r.id = $1
        LIMIT 1`,
      requestId,
    );
    const row = rows[0];
    if (!row) return "SKIPPED";
    // 취소 요청(d8) 결과는 «취소를 요청한 보호자»에게, 사유는 취소 요청에 단 원장 답으로.
    // (이 칸은 마이그레이션 20261110130000 의 것이라 취소 이벤트일 때만 읽는다)
    const cancelEvent = event === "CANCEL_APPROVED" || event === "CANCEL_REJECTED";
    let recipientUserId = row.requestedByUserId;
    let note = row.decisionNote;
    if (cancelEvent) {
      const extra = await prisma.$queryRawUnsafe<{ cancelRequestedByUserId: string | null; cancelDecisionNote: string | null }[]>(
        `SELECT "cancelRequestedByUserId", "cancelDecisionNote" FROM "EnrollmentChangeRequest" WHERE id = $1 LIMIT 1`,
        requestId,
      );
      if (!extra[0]?.cancelRequestedByUserId) return "SKIPPED";
      recipientUserId = extra[0].cancelRequestedByUserId;
      note = extra[0].cancelDecisionNote;
    } else if (row.requestedByUserId === row.decidedByUserId) {
      // 관리자가 직접 만든 변경(신청자 = 결정자)은 학부모 신청이 아니다.
      return "SKIPPED";
    }
    // 신청자가 «지금도» 이 학생의 보호자인지 다시 확인한다(학부모 화면과 같은 기준: childAccessSql + 병합 학생 제외).
    const access = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT s.id FROM "Student" s
        WHERE s.id = $1 AND ${await childAccessSql("s", "$2")} AND ${notMergedStudent("s")}
        LIMIT 1`,
      row.studentId, recipientUserId,
    );
    if (access.length !== 1) return "SKIPPED";

    // 휴원 수강료 처리(2026-11-10 m6) — 승인·SETTLED 알림에 «○원 이월/환불 예정» 한 줄.
    // 처리 표(마이그레이션 20261110180000)가 없으면 읽지 않는다(예전 알림 그대로).
    let settlementLine: string | null = null;
    if (event === "APPROVED" || event === "SETTLED") {
      const ready = await prisma.$queryRawUnsafe<{ found: string | null }[]>(
        `SELECT to_regclass('public."EnrollmentChangeSettlement"')::text AS found`,
      );
      if (ready[0]?.found) {
        const settled = await prisma.$queryRawUnsafe<{ mode: string; paidAmount: number; unpaidAmount: number }[]>(
          `SELECT mode, "paidAmount", "unpaidAmount" FROM "EnrollmentChangeSettlement" WHERE "requestId" = $1 LIMIT 1`,
          requestId,
        );
        if (settled[0] && isSettlementMode(settled[0].mode)) {
          settlementLine = settlementNoticeLine(settled[0].mode, Number(settled[0].paidAmount), Number(settled[0].unpaidAmount));
        }
      }
      // 따로 보내는 처리 안내인데 전할 금액이 없으면(«없음») 보내지 않는다
      if (event === "SETTLED" && !settlementLine) return "SKIPPED";
    }

    const notice = buildChangeDecisionNotice({
      event,
      studentName: row.studentName,
      className: row.className,
      kind: row.kind,
      effectiveFrom: row.effectiveFrom,
      decisionNote: event === "REJECTED" || event === "CANCEL_REJECTED" ? note : null,
      settlementLine,
    });
    const result = await deliverOperationalNotification({
      stableEventKey: `enrollment-change:${requestId}:${event}`,
      eventType: "ENROLLMENT_CHANGE",
      trigger: `ENROLLMENT_CHANGE_${event}`,
      studentId: row.studentId,
      recipientUserId,
      title: notice.title,
      message: notice.message,
      linkUrl: CHANGE_NOTICE_LINK,
      audienceScope: "EXTERNAL",
    });
    return result.duplicate ? "DUPLICATE" : "SENT";
  } catch (error) {
    // 개인정보·원문 오류는 남기지 않는다(신청 id 만).
    console.error("[enrollment-change-notify] 학부모 앱 알림 실패", requestId, event, error instanceof Error ? error.name : "");
    return "FAILED";
  }
}
