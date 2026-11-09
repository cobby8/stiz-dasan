import "server-only";
import { prisma } from "@/lib/prisma";
import { todayKst } from "@/lib/datetime/kst";
import { koreaServiceMonth } from "@/lib/regular/serviceMonth";
import { deliverOperationalNotification } from "@/lib/operational-notification-delivery";
import { buildRosterChangeNotice, ROSTER_NOTICE_TYPE, type RosterChangeCell } from "./regularRosterNotifyLogic";

// 셔틀 명단이 바뀌면 기사님께 바로 알림(2026-11-09 원장 결정 D5 — 정규 셔틀 기사님은 한 분).
// 경로: 운영 알림 전달 장부(deliverOperationalNotification) = 인앱 알림(Notification) + 웹 푸시(PushOutbox), 결석·셔틀 알림과 같은 길.
// 받는 사람: 현재 DB 의 기사 역할(주 역할 DRIVER 또는 승인된 추가 역할 DRIVER, 탈퇴 제외) — 기사님 새 학생 배정 권한과 같은 조건.
//   예전 경로(notifyOperationalStaff includeDriver)는 정규 배차 «저장 노선»에서 기사를 찾아 대부분 요일이 «보류»였다(저장 노선 폐지 예정).
// ⚠️ 명단 저장(트랜잭션)이 끝난 뒤에 부른다. 알림 실패는 저장 결과를 바꾸지 않는다(기록만 남기고 삼킨다).
// 바꾼 사람이 기사님 본인이면(기사님 새 학생 배정) 본인에게는 보내지 않는다.

export type RosterChangeEvent = {
  /** 바꾼 사람(User.id). 받는 사람에서 뺀다. 자동 생성 등은 null. */
  actorId: string | null;
  /** 고친 달('YYYY-MM'). 지난 달이면 보내지 않는다. */
  month: string;
  /** 바뀐 요일 × 방향(등원 BOARD / 하원 ALIGHT). 운영 정차·이상한 값은 알아서 빠진다. */
  cells: readonly { weekday: unknown; direction: unknown }[];
  /** 한 줄 요약 — «허재원 학생 정류장 변경» 처럼. 전화·주소는 넣지 않는다. */
  summary: string;
  studentId?: string | null;
};

const driverCondition = `(u.role::text='DRIVER' OR EXISTS (SELECT 1 FROM "UserRoleGrant" g WHERE g."userId"=u.id AND g.role='DRIVER' AND g.status='ACTIVE'))`;

/** 명단 변경 알림 — 실패해도 던지지 않는다. 보낸 기사 수를 돌려준다(테스트·로그용). */
export async function notifyDriversOfRosterChange(event: RosterChangeEvent): Promise<number> {
  try {
    // 'YYYY-MM' 은 사전순 = 시간순. 지난 달 명단을 고친 건 운행에 영향이 없다.
    if (!event.month || event.month < koreaServiceMonth()) return 0;
    const notice = buildRosterChangeNotice({
      month: event.month, cells: event.cells as RosterChangeCell[], summary: event.summary, todayYmd: todayKst(), nowMs: Date.now(),
    });
    if (!notice) return 0;
    const drivers = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT u.id FROM "User" u WHERE u."withdrawnAt" IS NULL AND ${driverCondition} AND ($1::text IS NULL OR u.id <> $1)`,
      event.actorId ?? null,
    );
    let sent = 0;
    for (const d of drivers) {
      try {
        const r = await deliverOperationalNotification({
          stableEventKey: notice.stableEventKey, // 10분 묶음 — 같은 칸 연속 변경은 한 번만(전달 장부 dedupeKey)
          eventType: ROSTER_NOTICE_TYPE,
          trigger: "REGULAR_ROSTER_EDIT",
          studentId: event.studentId ?? undefined,
          recipientUserId: String(d.id),
          title: notice.title,
          message: notice.message,
          linkUrl: notice.linkUrl,
        });
        if (r.inAppCreated) sent += 1;
      } catch (e) {
        console.error("[regular-roster-notify] 기사님 알림 실패:", e);
      }
    }
    return sent;
  } catch (e) {
    console.error("[regular-roster-notify] 기사님 알림 준비 실패:", e);
    return 0;
  }
}
