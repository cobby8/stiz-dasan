import { prisma } from "@/lib/prisma";
import { todayKst } from "@/lib/datetime/kst";
import { deliverParentNotification, getStudentParentRecipients } from "@/lib/staff-notifications";
// 방학특강 셔틀의 «신청 id → 학생»은 게이트웨이 한 곳으로만 읽는다(원본 신청 표를 여기서 직접 조회하지 않는다).
import { getConfirmedShuttleRoster } from "@/lib/seasonal/shuttleRoster";
import {
  BOARDING_NOTICE_DELAY_SECONDS,
  BOARDING_NOTICE_EVENT,
  BOARDING_NOTICE_MAX_AGE_SECONDS,
  BOARDING_PUSH_KEY_SUFFIX,
  boardingNoticeDedupeKey,
  boardingNoticeMessage,
  boardingNoticeTitle,
  pickBoardingNotices,
  type BoardingRow,
} from "@/lib/shuttle/boardingNoticeRules";

export type BoardingNoticeSweepResult = { candidates: number; delivered: number; duplicate: number; failed: number };

type SweepRow = BoardingRow & { nowEpoch: number | string | null };

/**
 * 기사님이 찍은 «탑승»을 1분 뒤 학부모에게 알린다 — push-outbox 크론(매분)이 부른다.
 * 규칙·문구는 boardingNoticeRules.ts 에 있다. 여기는 DB 에서 고르고 보내기만 한다.
 *
 * 어느 길(문자 링크·직원 로그인·정규·방학특강)로 찍혔든 탑승 표(ShuttleBoarding)를 기준으로 고르므로
 * 저장 경로마다 따로 붙일 필요가 없다. 받는 사람은 대표 보호자(Student.parentId)만.
 */
export async function sweepShuttleBoardingNotices(limit = 50, nowMs: number = Date.now()): Promise<BoardingNoticeSweepResult> {
  const today = todayKst(nowMs);
  const result: BoardingNoticeSweepResult = { candidates: 0, delivered: 0, duplicate: 0, failed: 0 };

  // 오늘 날짜의 «탑승» 줄 중 찍은 지 1분~30분인 것. 시각 비교는 초(epoch)로 한다 —
  // checkedAt 칼럼이 timestamp(UTC 로 저장)든 timestamptz 든 EXTRACT(EPOCH …) 값이 같아 어느 쪽이어도 맞다.
  const rows = await prisma.$queryRawUnsafe<SweepRow[]>(
    `SELECT b.direction, b."shuttleRequestId", b.status,
            r."studentId" AS "rosterStudentId", r.direction AS "stopDirection",
            EXTRACT(EPOCH FROM b."checkedAt")::float8 AS "checkedEpoch",
            EXTRACT(EPOCH FROM NOW())::float8 AS "nowEpoch"
       FROM "ShuttleBoarding" b
       LEFT JOIN "RegularShuttleStop" r ON b.direction = 'REGULAR' AND r.id = b."shuttleRequestId"
      WHERE b."serviceDate" = $1
        AND b.status = 'BOARDED'
        AND EXTRACT(EPOCH FROM NOW()) - EXTRACT(EPOCH FROM b."checkedAt") BETWEEN $2::int AND $3::int
      ORDER BY b."checkedAt"`,
    today, BOARDING_NOTICE_DELAY_SECONDS, BOARDING_NOTICE_MAX_AGE_SECONDS,
  );
  if (rows.length === 0) return result;

  // 방학특강 줄이 있을 때만 확정 명단을 읽는다(평소 정규만 도는 날은 조회를 아낀다).
  const seasonalStudentByRequest = new Map<string, string | null>();
  if (rows.some((row) => row.direction === "PICKUP" || row.direction === "DROPOFF")) {
    for (const entry of await getConfirmedShuttleRoster()) seasonalStudentByRequest.set(entry.shuttleRequestId, entry.studentId);
  }

  // «지금»은 DB 시계로 본다(서버 시계와 어긋나도 1분 판정이 흔들리지 않게).
  const dbNowMs = Math.round(Number(rows[0].nowEpoch) * 1000);
  const picked = pickBoardingNotices(rows, seasonalStudentByRequest, Number.isFinite(dbNowMs) && dbNowMs > 0 ? dbNowMs : nowMs);
  if (picked.length === 0) return result;

  // 대표 보호자만(병합된 학생·보호자 없는 학생은 여기서 빠진다).
  const recipients = await getStudentParentRecipients([...new Set(picked.map((p) => p.studentId))]);
  const recipientByStudent = new Map(recipients.map((r) => [r.studentId, r]));
  const planned = picked.flatMap((p) => {
    const recipient = recipientByStudent.get(p.studentId);
    if (!recipient) return [];
    return [{ ...p, recipient, dedupeKey: boardingNoticeDedupeKey({ dateYmd: today, leg: p.leg, studentId: p.studentId, userId: recipient.userId }) }];
  });
  if (planned.length === 0) return result;

  // 이미 보낸 것은 다시 고르지 않는다 — «웹푸시 행»을 기준으로 본다(결석 알림과 같은 방식):
  // 앱 알림만 남고 웹푸시 기록이 실패했으면 다음 분에 다시 골라 웹푸시만 채운다(앱 알림은 같은 키라 두 번 생기지 않는다).
  const sentRows = await prisma.$queryRawUnsafe<{ dedupeKey: string }[]>(
    `SELECT "dedupeKey" FROM "NotificationDelivery" WHERE "dedupeKey" = ANY($1::text[])`,
    planned.map((p) => `${p.dedupeKey}${BOARDING_PUSH_KEY_SUFFIX}`),
  );
  const sent = new Set(sentRows.map((r) => r.dedupeKey));
  const todo = planned.filter((p) => !sent.has(`${p.dedupeKey}${BOARDING_PUSH_KEY_SUFFIX}`)).slice(0, limit);
  result.candidates = todo.length;

  for (const item of todo) {
    try {
      const delivered = await deliverParentNotification({
        eventType: BOARDING_NOTICE_EVENT[item.leg],
        dedupeKey: item.dedupeKey,
        recipient: item.recipient,
        title: boardingNoticeTitle(item.leg),
        message: boardingNoticeMessage(item.leg, item.recipient.studentName, item.checkedAtMs),
        linkUrl: "/mypage",
      });
      if (delivered.duplicate) result.duplicate += 1;
      else result.delivered += 1;
    } catch (error) {
      // 한 명 실패가 나머지를 막지 않게 — 장부에 없으면 다음 분에 다시 고른다.
      result.failed += 1;
      console.error("[shuttle-boarding-notice] 탑승 알림 실패", { studentId: item.studentId, leg: item.leg, error });
    }
  }
  return result;
}
