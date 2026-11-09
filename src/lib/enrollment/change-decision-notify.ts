import { prisma } from "@/lib/prisma";
import { childAccessSql } from "@/lib/account/child-access";
import { notMergedStudent } from "@/lib/studentVisibility";
import { deliverOperationalNotification } from "@/lib/operational-notification-delivery";
import { buildChangeDecisionNotice, CHANGE_NOTICE_LINK, type ChangeNoticeEvent } from "@/lib/enrollment/parentChangeStatus";

// ── 수강 변경 결정·적용 → 신청한 학부모에게 앱 알림 (2026-11-10 원장 결정 d6) ─────────
//
// 왜: 예전엔 결정 알림을 «보류(HELD)»로만 남겨, 학부모는 승인·거절을 «⋯» 메뉴 안 화면에 들어가야만 알았다.
// 무엇: 인앱 알림 + 웹푸시만(운영 알림 전달 장부 = deliverOperationalNotification). 문자·알림톡은 보내지 않는다.
// 누구에게: 신청자(requestedByUserId) 한 명 — 그 사람이 지금도 그 학생의 보호자일 때만.
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
      `SELECT r."requestedByUserId", r."decidedByUserId", r."studentId", s.name AS "studentName", fc.name AS "className",
              r.kind, to_char(r."effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom", r."decisionNote"
         FROM "EnrollmentChangeRequest" r
         JOIN "Student" s ON s.id = r."studentId" AND ${notMergedStudent("s")}
         LEFT JOIN "Class" fc ON fc.id = r."fromClassId"
        WHERE r.id = $1
        LIMIT 1`,
      requestId,
    );
    const row = rows[0];
    // 관리자가 직접 만든 변경(신청자 = 결정자)은 학부모 신청이 아니다.
    if (!row || row.requestedByUserId === row.decidedByUserId) return "SKIPPED";
    // 신청자가 «지금도» 이 학생의 보호자인지 다시 확인한다(학부모 화면과 같은 기준: childAccessSql + 병합 학생 제외).
    const access = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT s.id FROM "Student" s
        WHERE s.id = $1 AND ${await childAccessSql("s", "$2")} AND ${notMergedStudent("s")}
        LIMIT 1`,
      row.studentId, row.requestedByUserId,
    );
    if (access.length !== 1) return "SKIPPED";

    const notice = buildChangeDecisionNotice({
      event,
      studentName: row.studentName,
      className: row.className,
      kind: row.kind,
      effectiveFrom: row.effectiveFrom,
      decisionNote: event === "REJECTED" ? row.decisionNote : null,
    });
    const result = await deliverOperationalNotification({
      stableEventKey: `enrollment-change:${requestId}:${event}`,
      eventType: "ENROLLMENT_CHANGE",
      trigger: `ENROLLMENT_CHANGE_${event}`,
      studentId: row.studentId,
      recipientUserId: row.requestedByUserId,
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
