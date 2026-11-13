/**
 * 체육관 대관 → «스티즈 다산점» 구글 캘린더(GOOGLE_CALENDAR_ID) 맞추기 (2026-11-13 원장 요청).
 *
 * 왜 이름·번호를 안 넣나: 이 캘린더는 «공개» 캘린더다(사이트 연간일정이 public ICS 로 읽는다).
 *   누구나 볼 수 있어서 제목은 «체육관 대관 · N명», 설명은 관리자 화면 링크만 넣는다(원장 결정).
 * 사이트 연간일정·청구 수업일 계산은 이 제목으로 시작하는 일정을 읽지 않는다(googleCalendar.ts 의 RENTAL_CALENDAR_TITLE 거름).
 *
 * 언제: 확정(PAID)·사용 완료·환불 완료 = 실제로 쓰는(쓴) 시간 → 일정 있음 / 거절·취소·그 전 단계 → 일정 없음.
 * 캘린더 저장이 실패해도 대관 처리는 되돌리지 않는다(로그만 남긴다).
 */
import { prisma } from "@/lib/prisma";
import { deleteCalendarEventChecked, upsertTimedCalendarEvent } from "@/lib/googleCalendarWrite";
import { RENTAL_CALENDAR_TITLE } from "@/lib/googleCalendar";
import { rentalInstantMs, type RentalStatus } from "@/lib/rental/gym-rental-rules";

const ON_CALENDAR: readonly RentalStatus[] = ["PAID", "COMPLETED", "REFUNDED"];
const ADMIN_URL = "https://www.stiz-dasan.kr/admin/inbox?kind=RENTAL";

type CalendarRow = { id: string; status: RentalStatus; rentalDate: string; startMinute: number; endMinute: number; headcount: number; calendarEventId: string | null };

/** 그 대관의 지금 상태에 맞게 캘린더 일정을 만들거나·옮기거나·지운다. 실패해도 던지지 않는다. */
export async function syncRentalCalendar(id: string): Promise<void> {
  try {
    const rows = await prisma.$queryRawUnsafe<CalendarRow[]>(
      `SELECT id, status, "rentalDate",
              COALESCE("startMinute", "startHour" * 60)::int AS "startMinute",
              COALESCE("endMinute", "endHour" * 60)::int AS "endMinute", headcount, "calendarEventId"
         FROM "GymRentalRequest" WHERE id = $1`,
      id,
    );
    const row = rows[0];
    if (!row) return;

    if (!ON_CALENDAR.includes(row.status)) {
      // 지우기에 성공했을 때만 ID 를 비운다(실패하면 남겨 두어 다음에 다시 지울 수 있게)
      if (row.calendarEventId && await deleteCalendarEventChecked(row.calendarEventId)) await saveEventId(row.id, null);
      return;
    }

    const eventId = await upsertTimedCalendarEvent(row.calendarEventId, {
      title: `${RENTAL_CALENDAR_TITLE} · ${row.headcount}명`,
      startIso: new Date(rentalInstantMs(row.rentalDate, Number(row.startMinute))).toISOString(),
      endIso: new Date(rentalInstantMs(row.rentalDate, Number(row.endMinute))).toISOString(),
      description: `신청 내용: ${ADMIN_URL}`,
    });
    if (eventId && eventId !== row.calendarEventId) await saveEventId(row.id, eventId);
  } catch (error) {
    console.error("[rental] calendar sync failed:", (error as Error)?.message);
  }
}

async function saveEventId(id: string, eventId: string | null) {
  await prisma.$executeRawUnsafe(`UPDATE "GymRentalRequest" SET "calendarEventId" = $2 WHERE id = $1`, id, eventId);
}
