import { prisma } from "@/lib/prisma";
import { resolveTrialScheduleFromRow, seoulDateInputValue, type TrialScheduleResolutionRow } from "@/lib/trial-schedule-time";
import { formatTrialSmsDateTime } from "@/lib/trial-sms-time";

export class TrialScheduleResolutionError extends Error {}

export type TrialScheduleOption = {
  classId: string;
  className: string;
  startTime: string;
};

/** 관리자에게 해당 날짜에 실제 운영 가능한 반만 보여준다. 저장 시에도 같은 resolver로 재검증한다. */
export async function listTrialScheduleOptionsForDate(selectedDate: string): Promise<TrialScheduleOption[]> {
  if (!/^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(selectedDate)
    || seoulDateInputValue(`${selectedDate}T12:00:00+09:00`) !== selectedDate) {
    throw new TrialScheduleResolutionError("실제 달력 날짜를 선택해 주세요.");
  }
  const rows = await prisma.$queryRawUnsafe<Array<TrialScheduleResolutionRow & {
    classId: string; className: string;
  }>>(
    `SELECT c.id AS "classId",c.name AS "className",
            cso."startTimeOverride" AS "overrideStart",
            cso."isHidden" AS "overrideHidden",
            ss."startTime" AS "scheduleStart",
            ss."dayKey" AS "scheduleDay",ss."isHidden" AS "scheduleHidden",
            ss."activeFrom" AS "scheduleActiveFrom",ss."activeTo" AS "scheduleActiveTo",
            cs."startTime" AS "customStart",
            cs."dayKey" AS "customDay",cs."isHidden" AS "customHidden",
            c."startTime" AS "classStart",c."dayOfWeek" AS "classDay",
            c."slotKey" AS "classSlotKey"
       FROM "Class" c
       LEFT JOIN "ClassSlotOverride" cso ON cso."slotKey"=c."slotKey"
       LEFT JOIN "ScheduleSlot" ss ON ss."slotKey"=c."slotKey"
       LEFT JOIN "CustomClassSlot" cs ON (cs.id=c."slotKey" OR ('custom-' || cs.id)=c."slotKey")
      WHERE c."slotKey" IS NOT NULL`,
  );
  const options: TrialScheduleOption[] = [];
  for (const row of rows) {
    if (!row.classSlotKey) continue;
    try {
      const resolved = resolveTrialScheduleFromRow(row, {
        selectedDate, slotKey: row.classSlotKey, scheduledClassId: row.classId,
      });
      options.push({
        classId: row.classId,
        className: row.className,
        startTime: resolved.startTime,
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // 다른 요일·비활성·숨김·시간 미확정 반은 선택 후보가 아니다.
    }
  }
  return options.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.className.localeCompare(b.className));
}

export async function resolveCanonicalTrialSchedule(input: { selectedDate: string; slotKey: string; scheduledClassId?: string | null }) {
  const rows = await prisma.$queryRawUnsafe<TrialScheduleResolutionRow[]>(
    `SELECT o."startTimeOverride" AS "overrideStart",o."isHidden" AS "overrideHidden",
            ss."startTime" AS "scheduleStart",ss."dayKey" AS "scheduleDay",ss."isHidden" AS "scheduleHidden",
            ss."activeFrom" AS "scheduleActiveFrom",ss."activeTo" AS "scheduleActiveTo",
            cs."startTime" AS "customStart",cs."dayKey" AS "customDay",cs."isHidden" AS "customHidden",
            c."startTime" AS "classStart",c."dayOfWeek" AS "classDay",c."slotKey" AS "classSlotKey",c.name AS "className"
       FROM (SELECT $1::text AS "slotKey") key
       LEFT JOIN "ClassSlotOverride" o ON o."slotKey"=key."slotKey"
       LEFT JOIN "ScheduleSlot" ss ON ss."slotKey"=key."slotKey"
       LEFT JOIN "CustomClassSlot" cs ON (cs.id=key."slotKey" OR ('custom-' || cs.id)=key."slotKey")
       LEFT JOIN LATERAL (
         SELECT name,"startTime","dayOfWeek","slotKey" FROM "Class"
          WHERE ($2::text IS NOT NULL AND id=$2) OR ($2::text IS NULL AND "slotKey"=key."slotKey")
          ORDER BY CASE WHEN id=$2 THEN 0 ELSE 1 END,id LIMIT 1
       ) c ON true`, input.slotKey.trim(), input.scheduledClassId || null,
  );
  if (!rows[0]) throw new TrialScheduleResolutionError("수업 시간표를 찾지 못했습니다.");
  try {
    const resolved = resolveTrialScheduleFromRow(rows[0], input);
    return { ...resolved, formattedDate: formatTrialSmsDateTime(resolved.scheduledDate) };
  } catch (error) {
    throw new TrialScheduleResolutionError(error instanceof Error ? error.message : "체험 시간을 확정할 수 없습니다.");
  }
}
