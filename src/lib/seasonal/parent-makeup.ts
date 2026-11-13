import { prisma } from "@/lib/prisma";
import { getMakeupOptions, createMakeup } from "@/lib/seasonal/makeup";
// 학부모용 후보 정리(숫자 제거)는 순수 모듈 한 곳 — 실행 테스트가 바로 불러 쓴다
import { toParentSeasonalCandidates } from "@/lib/seasonal/parentMakeupView";

function digits(s?: string | null) { return (s || "").replace(/\D/g, ""); }
function seoulLabel(value: Date | string | null) {
  if (!value) return null;
  const d = typeof value === "string" ? new Date(value) : value;
  const f = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${Number(p.month)}/${Number(p.day)}(${(p.weekday || "").replace("요일", "")})`;
}

async function parentPhone(parentUserId: string) {
  const u = await prisma.$queryRawUnsafe<any[]>(`SELECT phone FROM "User" WHERE id = $1 LIMIT 1`, parentUserId);
  return digits(u[0]?.phone);
}

// 학부모 화면 컨텍스트: 내 아이의 결석(보강 미배정) + 각 결석의 보강 후보 + 기존 보강내역
export async function getParentSeasonalContext(parentUserId: string) {
  const phone = await parentPhone(parentUserId);
  if (!phone) return { phoneKnown: false, absences: [], makeups: [] };

  const absences = await prisma.$queryRawUnsafe<any[]>(
    `SELECT e.id AS "enrollmentDateId"
       FROM "SpecialProgramEnrollmentDate" e
       JOIN "SpecialProgramApplicationItem" it ON it.id = e."applicationItemId"
       JOIN "SpecialProgramApplication" a ON a.id = it."applicationId"
       JOIN "SpecialProgramSessionDate" sd ON sd.id = e."sessionDateId"
      WHERE e.kind = 'REGULAR' AND e.status <> 'CANCELLED'
        -- 보강 후보 = ①선생님 출결에서 결석(ABSENT) 처리된 좌석
        --           + ②학부모가 '보강' 사유로 사전 신고한 좌석(EXCUSED + Absence.resolution='MAKEUP')
        --   ※ 질병·부상(=CARRYOVER 이월)은 보강 후보 아님 → resolution='MAKEUP' 조건으로 자연 제외.
        AND (
          e."attendanceStatus" = 'ABSENT'
          OR (
            e."attendanceStatus" = 'EXCUSED'
            AND EXISTS (
              SELECT 1 FROM "SpecialProgramAbsence" ab
               WHERE ab."enrollmentDateId" = e.id
                 AND ab.resolution = 'MAKEUP'
                 AND ab.status <> 'CANCELLED'
            )
          )
        )
        AND regexp_replace(a."parentPhone", '[^0-9]', '', 'g') = $1
        AND NOT EXISTS (
          SELECT 1 FROM "SpecialProgramMakeup" m
           WHERE m."applicationItemId" = e."applicationItemId" AND m."absentSessionDateId" = e."sessionDateId"
             AND m.status NOT IN ('CANCELLED','REJECTED')
        )
      ORDER BY sd."startsAt" DESC`,
    phone,
  );

  const withOptions = [];
  for (const ab of absences) {
    const opt = await getMakeupOptions(ab.enrollmentDateId);
    withOptions.push({
      enrollmentDateId: ab.enrollmentDateId,
      childName: opt.absence.childName, offeringTitle: opt.absence.offeringTitle,
      absentLabel: opt.absence.absentLabel, windowEndLabel: opt.windowEndLabel,
      ...toParentSeasonalCandidates(opt),
    });
  }

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT m.id, m.status, m."targetType", a."childName", o.title AS "offeringTitle",
            absd."startsAt" AS "absentStartsAt", tsd."startsAt" AS "targetStartsAt", c.name AS "targetClassName", m."targetDate"
       FROM "SpecialProgramMakeup" m
       JOIN "SpecialProgramApplicationItem" it ON it.id = m."applicationItemId"
       JOIN "SpecialProgramApplication" a ON a.id = it."applicationId"
       JOIN "SpecialProgramOffering" o ON o.id = m."offeringId"
       LEFT JOIN "SpecialProgramSessionDate" absd ON absd.id = m."absentSessionDateId"
       LEFT JOIN "SpecialProgramSessionDate" tsd ON tsd.id = m."targetSessionDateId"
       LEFT JOIN "Class" c ON c.id = m."targetClassId"
      WHERE regexp_replace(a."parentPhone", '[^0-9]', '', 'g') = $1 AND m.status NOT IN ('CANCELLED','REJECTED')
      ORDER BY m."requestedAt" DESC`,
    phone,
  );

  return {
    phoneKnown: true,
    absences: withOptions,
    makeups: rows.map((r) => ({
      id: r.id, status: r.status, targetType: r.targetType, childName: r.childName, offeringTitle: r.offeringTitle,
      absentLabel: seoulLabel(r.absentStartsAt),
      targetLabel: r.targetType === "SEASONAL"
        ? seoulLabel(r.targetStartsAt)
        : (r.targetClassName ? `${r.targetClassName}${r.targetDate ? " · " + seoulLabel(r.targetDate) : ""}` : null),
    })),
  };
}

// 학부모가 보강 신청 (관리자 승인 대기 상태로 생성)
export async function requestParentMakeup(parentUserId: string, input: {
  enrollmentDateId: string; targetType: "SEASONAL" | "REGULAR";
  targetSessionDateId?: string | null; targetClassId?: string | null; targetDate?: string | null; note?: string | null;
}) {
  const phone = await parentPhone(parentUserId);
  if (!phone) throw new Error("PARENT_PHONE_UNKNOWN");
  const own = await prisma.$queryRawUnsafe<any[]>(
    `SELECT 1 FROM "SpecialProgramEnrollmentDate" e
       JOIN "SpecialProgramApplicationItem" it ON it.id = e."applicationItemId"
       JOIN "SpecialProgramApplication" a ON a.id = it."applicationId"
      WHERE e.id = $1 AND regexp_replace(a."parentPhone", '[^0-9]', '', 'g') = $2 LIMIT 1`,
    input.enrollmentDateId, phone,
  );
  if (!own[0]) throw new Error("NOT_OWNER");
  return createMakeup({
    enrollmentDateId: input.enrollmentDateId, targetType: input.targetType,
    targetSessionDateId: input.targetSessionDateId ?? null, targetClassId: input.targetClassId ?? null,
    targetDate: input.targetDate ?? null, requestedBy: "PARENT", note: input.note ?? null,
  });
}
