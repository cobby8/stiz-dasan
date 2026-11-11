import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { loadSeasonalMakeupRooms } from "@/lib/seasonal/makeup-capacity";
import { notMergedStudent } from "@/lib/studentVisibility";
import { MAKEUP_WINDOW_DAYS, findNextClassDate } from "@/lib/seasonal/makeupWindow";

// 방학특강 보강 라이브러리. 규칙: 지금~결석일+2개월 사이, 결석 1건당 보강 1건, 정원(특강 12/정규반 capacity) 미만.
export { MAKEUP_WINDOW_DAYS };

// "2026년 초등 5학년", "초등 5학년", "5학년", "중등 2학년" → 비교 가능한 숫자(초1=1..초6=6, 중1=7..중3=9)
export function gradeToNumber(raw?: string | null): number | null {
  if (!raw) return null;
  const s = String(raw);
  const m = s.match(/(\d+)\s*학년/) || s.match(/(\d+)/);
  const n = m ? parseInt(m[1], 10) : NaN;
  if (!Number.isFinite(n)) return null;
  if (/중/.test(s)) return n + 6;
  return n;
}

const DOW_MAP: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
  일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6,
  SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
};
function parseDow(raw?: string | null): number | null {
  if (!raw) return null;
  const key = String(raw).trim().toUpperCase().replace("요일", "");
  const short = key.slice(0, 3);
  if (key in DOW_MAP) return DOW_MAP[key];
  if (short in DOW_MAP) return DOW_MAP[short];
  const one = String(raw).trim().charAt(0);
  if (one in DOW_MAP) return DOW_MAP[one];
  return null;
}
function num(v: unknown) { return v == null ? 0 : Number(v); }
function seoulLabel(value: Date | string) {
  const d = typeof value === "string" ? new Date(value) : value;
  const f = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${Number(p.month)}/${Number(p.day)}(${(p.weekday || "").replace("요일", "")})`;
}

// 결석 1건에 대한 보강 후보 조회
export async function getMakeupOptions(enrollmentDateId: string) {
  const absRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT e.id, e."applicationItemId", e."sessionDateId" AS "absentSessionDateId", e."attendanceStatus", e."studentId",
            it."offeringId", o.capacity, o.title AS "offeringTitle",
            a."childName", a."childGrade",
            sd."startsAt" AS "absentStartsAt"
       FROM "SpecialProgramEnrollmentDate" e
       JOIN "SpecialProgramApplicationItem" it ON it.id = e."applicationItemId"
       JOIN "SpecialProgramApplication" a ON a.id = it."applicationId"
       JOIN "SpecialProgramOffering" o ON o.id = it."offeringId"
       JOIN "SpecialProgramSessionDate" sd ON sd.id = e."sessionDateId"
      WHERE e.id = $1 LIMIT 1`,
    enrollmentDateId,
  );
  const abs = absRows[0];
  if (!abs) throw new Error("ABSENCE_NOT_FOUND");

  const existing = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, status, "targetType", "targetSessionDateId", "targetClassId", "targetDate"
       FROM "SpecialProgramMakeup"
      WHERE "applicationItemId" = $1 AND "absentSessionDateId" = $2 AND status NOT IN ('CANCELLED','REJECTED')
      LIMIT 1`,
    abs.applicationItemId, abs.absentSessionDateId,
  );

  // 같은 특강 다른 날짜 후보.
  // NOT EXISTS 조건: 그 날 이미 활성 좌석(정규 수강일 포함)이 있으면 후보에서 뺀다.
  // = "원래 수업이 있는 날"에는 보강을 잡지 않는다(저장 경로 createMakeup 에도 같은 검사가 있다).
  const seasonal = await prisma.$queryRawUnsafe<any[]>(
    `SELECT sd.id, sd."startsAt", sd."endsAt"
       FROM "SpecialProgramSessionDate" sd
      WHERE sd."offeringId" = $1
        AND sd.id <> $2
        -- 시작점은 결석일이 아니라 **지금**이다. 결석을 미리 고지받으면(예: 8/20 결석을 8/12 신고)
        -- 오늘~결석일 사이에도 보강을 잡을 수 있어야 한다. 이미 시작한 수업은 배정해도 갈 수 없어 뺀다.
        AND sd."startsAt" > now()
        -- 끝점은 약관대로 결석일($3) 기준 2개월.
        AND sd."startsAt" <= ($3::timestamptz + interval '60 days')
        AND NOT EXISTS (
          SELECT 1 FROM "SpecialProgramEnrollmentDate" e3
           WHERE e3."applicationItemId" = $4 AND e3."sessionDateId" = sd.id AND e3.status <> 'CANCELLED'
        )
      ORDER BY sd."startsAt" ASC`,
    abs.offeringId, abs.absentSessionDateId, abs.absentStartsAt, abs.applicationItemId,
  );
  // 정원 여유는 승인과 같은 "형제 반 그룹 × 요일" 기준으로 판정한다(makeup-capacity.ts).
  const seasonalRooms = await loadSeasonalMakeupRooms(abs.offeringId, seasonal.map((row) => row.id));
  const seasonalAvailable = seasonal.filter((row) => seasonalRooms.get(row.id)?.hasRoom !== false);

  // 정규수업(정규반) 후보 — 학년 구성 유사 순
  const classes = await prisma.$queryRawUnsafe<any[]>(
    `SELECT c.id, c.name, c."dayOfWeek", c."startTime", c."endTime", c.capacity, u.name AS instructor,
            COUNT(en.id) FILTER (WHERE en.status = 'ACTIVE') AS enrolled,
            array_remove(array_agg(st.grade) FILTER (WHERE en.status = 'ACTIVE'), NULL) AS grades
       FROM "Class" c
       LEFT JOIN "User" u ON u.id = c."instructorId"
       LEFT JOIN "Enrollment" en ON en."classId" = c.id AND en.status = 'ACTIVE'
       -- LEFT JOIN 이라 ON 절에 넣는다. WHERE 로 옮기면 수강생이 0명인 반이 통째로 사라진다.
       LEFT JOIN "Student" st ON st.id = en."studentId" AND ${notMergedStudent("st")}
      GROUP BY c.id, u.name`,
  );

  const childGrade = gradeToNumber(abs.childGrade);
  const absStart = new Date(abs.absentStartsAt);
  const windowEnd = new Date(absStart.getTime() + MAKEUP_WINDOW_DAYS * 86400000);
  const nowMs = Date.now();
  const regular = classes
    .map((c) => {
      const grades = (c.grades || []).map((g: string) => gradeToNumber(g)).filter((x: number | null) => x != null) as number[];
      const avg = grades.length ? grades.reduce((s, x) => s + x, 0) / grades.length : null;
      const gradeDiff = childGrade != null && avg != null ? Math.abs(childGrade - avg) : null;
      const enrolled = num(c.enrolled);
      const cap = c.capacity == null ? null : Number(c.capacity);
      const dow = parseDow(c.dayOfWeek);
      // 결석일이 아니라 **오늘**부터 그 반 요일의 첫 날을 찾는다(오늘 수업이 이미 시작했으면 다음 주).
      const nextDate = findNextClassDate({
        dayOfWeek: dow, startTime: c.startTime, nowMs, windowEndMs: windowEnd.getTime(),
      });
      return {
        classId: c.id, name: c.name, instructor: c.instructor ?? null,
        dayOfWeek: c.dayOfWeek, startTime: c.startTime, endTime: c.endTime,
        capacity: cap, enrolled, hasRoom: cap == null ? true : enrolled < cap,
        gradeAvg: avg, gradeDiff, nextDate,
      };
    })
    .filter((c) => c.hasRoom && c.nextDate)
    .sort((a, b) => {
      const ga = a.gradeDiff == null ? 99 : a.gradeDiff;
      const gb = b.gradeDiff == null ? 99 : b.gradeDiff;
      if (ga !== gb) return ga - gb;
      return (a.nextDate || "").localeCompare(b.nextDate || "");
    })
    .slice(0, 6);

  return {
    absence: {
      enrollmentDateId: abs.id, applicationItemId: abs.applicationItemId, offeringId: abs.offeringId,
      offeringTitle: abs.offeringTitle, childName: abs.childName, childGrade: abs.childGrade ?? null,
      absentSessionDateId: abs.absentSessionDateId, absentLabel: seoulLabel(abs.absentStartsAt),
      isAbsent: abs.attendanceStatus === "ABSENT",
    },
    alreadyAssigned: existing[0] ?? null,
    windowEndLabel: seoulLabel(windowEnd),
    seasonalCandidates: seasonalAvailable.map((s) => {
      const room = seasonalRooms.get(s.id);
      return {
        sessionDateId: s.id, label: seoulLabel(s.startsAt),
        filled: room ? room.filled : 0,
        capacity: room ? room.capacity : (abs.capacity == null ? null : Number(abs.capacity)),
        remaining: room ? room.remaining : null,
      };
    }),
    regularCandidates: regular.map((r) => ({
      classId: r.classId, name: r.name, instructor: r.instructor,
      schedule: `${r.dayOfWeek} ${r.startTime}~${r.endTime}`,
      nextDate: r.nextDate, nextLabel: r.nextDate ? seoulLabel(r.nextDate + "T00:00:00+09:00") : null,
      capacity: r.capacity, enrolled: r.enrolled,
      gradeAvg: r.gradeAvg == null ? null : Math.round(r.gradeAvg * 10) / 10,
      gradeDiff: r.gradeDiff == null ? null : Math.round(r.gradeDiff * 10) / 10,
    })),
  };
}

/**
 * "그 날은 원래 수업이 있는 날입니다" 가드.
 * 대상 날짜에 이 학생의 활성 좌석(status <> 'CANCELLED')이 이미 있으면 보강을 만들지 않는다.
 * - sessionDateId 기준: 특강 보강(같은 회차 자리 충돌 = 유니크키 충돌 지점)
 * - ymd 기준: 정규수업 보강(같은 날 특강 수업이 있으면 이중 배정)
 * 관리자·학부모 두 경로가 모두 createMakeup 을 타므로 여기 한 곳만 막으면 양쪽이 막힌다.
 */
async function assertTargetDateFree(applicationItemId: string, target: { sessionDateId?: string | null; ymd?: string | null }) {
  if (target.sessionDateId) {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT e.id FROM "SpecialProgramEnrollmentDate" e
        WHERE e."applicationItemId" = $1 AND e."sessionDateId" = $2 AND e.status <> 'CANCELLED' LIMIT 1`,
      applicationItemId, target.sessionDateId,
    );
    if (rows[0]) throw new Error("TARGET_ALREADY_ENROLLED");
    return;
  }
  if (!target.ymd) return;
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT e.id FROM "SpecialProgramEnrollmentDate" e
       JOIN "SpecialProgramSessionDate" sd ON sd.id = e."sessionDateId"
      WHERE e."applicationItemId" = $1 AND e.status <> 'CANCELLED'
        AND to_char(sd."startsAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') = $2
      LIMIT 1`,
    applicationItemId, target.ymd,
  );
  if (rows[0]) throw new Error("TARGET_ALREADY_ENROLLED");
}

// 보강 생성 (관리자 직접=SCHEDULED / 학부모 신청=REQUESTED)
export async function createMakeup(input: {
  enrollmentDateId: string;
  sourceAbsenceId?: string;
  targetType: "SEASONAL" | "REGULAR";
  targetSessionDateId?: string | null;
  targetClassId?: string | null;
  targetDate?: string | null;
  requestedBy?: "ADMIN" | "PARENT";
  userId?: string | null;
  note?: string | null;
}) {
  const absRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT e.id, e."applicationItemId", e."sessionDateId" AS "absentSessionDateId", e."studentId",
            it."offeringId", o.capacity
       FROM "SpecialProgramEnrollmentDate" e
       JOIN "SpecialProgramApplicationItem" it ON it.id = e."applicationItemId"
       JOIN "SpecialProgramOffering" o ON o.id = it."offeringId"
      WHERE e.id = $1 LIMIT 1`,
    input.enrollmentDateId,
  );
  const abs = absRows[0];
  if (!abs) throw new Error("ABSENCE_NOT_FOUND");

  const assertNotAssigned = async (db: Prisma.TransactionClient) => {
    const existing = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "SpecialProgramMakeup"
        WHERE "applicationItemId" = $1 AND "absentSessionDateId" = $2 AND status NOT IN ('CANCELLED','REJECTED') LIMIT 1`,
      abs.applicationItemId, abs.absentSessionDateId,
    );
    if (existing.length) throw new Error("MAKEUP_ALREADY_EXISTS");
  };
  const sourceAbsenceId = input.sourceAbsenceId;
  if (!sourceAbsenceId) await assertNotAssigned(prisma);

  const requestedBy = input.requestedBy ?? "ADMIN";
  const status = requestedBy === "ADMIN" ? "SCHEDULED" : "REQUESTED";
  const id = randomUUID();

  if (input.targetType === "SEASONAL") {
    if (!input.targetSessionDateId) throw new Error("TARGET_SESSION_DATE_REQUIRED");
    const okRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT sd.id FROM "SpecialProgramSessionDate" sd WHERE sd.id = $1 AND sd."offeringId" = $2 LIMIT 1`,
      input.targetSessionDateId, abs.offeringId,
    );
    if (!okRows[0]) throw new Error("TARGET_NOT_IN_OFFERING");

    // (1) 원래 수업이 있는 날인지 먼저 막는다(저장 경로 방어 — UI 후보 목록만 믿지 않는다).
    await assertTargetDateFree(abs.applicationItemId, { sessionDateId: input.targetSessionDateId });

    // (2) 정원은 승인 경로와 같은 "형제 반 그룹 × 요일" 기준으로 본다.
    const room = (await loadSeasonalMakeupRooms(abs.offeringId, [input.targetSessionDateId])).get(input.targetSessionDateId);
    if (room && !room.hasRoom) throw new Error("TARGET_FULL");
    if (room?.overCapacityBaseline) {
      // 이미 정원을 넘긴 반은 막지 않는다(운영 마비 방지). 대신 흔적을 남겨 나중에 확인할 수 있게 한다.
      console.warn("[seasonal makeup] 정원을 이미 넘긴 반에 보강을 허용했습니다.", {
        offeringId: abs.offeringId, targetSessionDateId: input.targetSessionDateId,
        weekday: room.weekday, capacity: room.capacity,
        regularOccupied: room.regularOccupied, makeupOccupied: room.makeupOccupied,
      });
    }
  } else if (input.targetDate) {
    // 정규수업 보강도 같은 날 특강 수업이 있으면 이중 배정이 된다.
    await assertTargetDateFree(abs.applicationItemId, { ymd: String(input.targetDate).slice(0, 10) });
  }

  const insertMakeup = (db: Prisma.TransactionClient) => db.$executeRawUnsafe(
    `INSERT INTO "SpecialProgramMakeup"
       ("id","applicationItemId","studentId","offeringId","absentSessionDateId","targetType",
        "targetSessionDateId","targetClassId","targetDate","status","requestedBy","requestedByUserId","approvedByUserId","decidedAt","note")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    id, abs.applicationItemId, abs.studentId ?? null, abs.offeringId, abs.absentSessionDateId, input.targetType,
    input.targetSessionDateId ?? null, input.targetClassId ?? null, input.targetDate ? new Date(input.targetDate) : null,
    status, requestedBy, requestedBy === "ADMIN" ? (input.userId ?? null) : null,
    requestedBy === "ADMIN" ? (input.userId ?? null) : null, requestedBy === "ADMIN" ? new Date() : null,
    input.note ?? null,
  );

  if (sourceAbsenceId) {
    await prisma.$transaction(async (tx) => {
      const [source] = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "SpecialProgramAbsence"
          WHERE id = $1 AND "enrollmentDateId" = $2 AND status = 'CONFIRMED' AND resolution = 'MAKEUP'
          FOR UPDATE`,
        sourceAbsenceId, input.enrollmentDateId,
      );
      if (!source) throw new Error("MAKEUP_SOURCE_CONFLICT");
      await assertNotAssigned(tx);
      await insertMakeup(tx);
      if (status === "SCHEDULED" && input.targetType === "SEASONAL") await ensureSeasonalMakeupSlot(id, tx);
    });
    return { id, status };
  }

  await insertMakeup(prisma);
  if (status === "SCHEDULED" && input.targetType === "SEASONAL") {
    try {
      await ensureSeasonalMakeupSlot(id);
    } catch (error) {
      // 좌석을 못 만들면 "배정됐다고 표시되는데 출석부에는 없는" 유령 보강이 된다.
      // 하드 DELETE 없이 방금 만든 보강만 소프트 취소하고 에러를 그대로 올린다.
      await prisma.$executeRawUnsafe(
        `UPDATE "SpecialProgramMakeup" SET status='CANCELLED', "decidedAt"=now(), "updatedAt"=now() WHERE id=$1`, id,
      );
      throw error;
    }
  }
  return { id, status };
}

/**
 * 승인 시 특강 보강 대상 날짜에 수강일(kind=MAKEUP) 생성.
 *
 * ⚠️ DO UPDATE 의 WHERE 가 이 함수의 안전장치다.
 * - 활성 좌석(status <> 'CANCELLED')은 갱신 대상에서 제외 → 정규 수강일을 보강이 덮지 못한다.
 * - 출결이 찍힌 행(attendanceStatus IS NOT NULL)도 제외 → 출결 기록은 어떤 자동 로직도 건드리지 않는다.
 * 조건에 걸려 아무 행도 바뀌지 않으면 조용히 넘어가지 않고 에러를 던져 호출부가 되돌리게 한다.
 */
async function ensureSeasonalMakeupSlot(makeupId: string, db: Prisma.TransactionClient = prisma) {
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT m.id, m."applicationItemId", m."studentId", m."offeringId", m."targetSessionDateId"
       FROM "SpecialProgramMakeup" m WHERE m.id = $1 AND m."targetType"='SEASONAL' AND m."targetSessionDateId" IS NOT NULL LIMIT 1`,
    makeupId,
  );
  const m = rows[0];
  if (!m) return;
  const affected = await db.$executeRawUnsafe(
    `INSERT INTO "SpecialProgramEnrollmentDate"
       ("applicationItemId","offeringId","sessionDateId","studentId","kind","status","makeupId")
     VALUES ($1,$2,$3,$4,'MAKEUP','SCHEDULED',$5)
     ON CONFLICT ("applicationItemId","sessionDateId") DO UPDATE
       SET status='SCHEDULED', kind='MAKEUP', "makeupId"=EXCLUDED."makeupId", "updatedAt"=now()
     WHERE "SpecialProgramEnrollmentDate".status = 'CANCELLED'
       AND "SpecialProgramEnrollmentDate"."attendanceStatus" IS NULL`,
    m.applicationItemId, m.offeringId, m.targetSessionDateId, m.studentId ?? null, m.id,
  );
  if (Number(affected) === 0) {
    console.warn("[seasonal makeup] 보강 좌석을 만들 수 없습니다(이미 활성 좌석 또는 출결 기록 존재).", {
      makeupId, applicationItemId: m.applicationItemId, targetSessionDateId: m.targetSessionDateId,
    });
    throw new Error("TARGET_ALREADY_ENROLLED");
  }
}

// The locked row keeps a decision and its linked seat consistent.
type MakeupDecision = "APPROVE" | "REJECT" | "CANCEL" | "ATTENDED" | "NO_SHOW";

export async function decideMakeup(
  makeupId: string,
  action: MakeupDecision,
  userId?: string | null,
  expectedStatus?: string,
) {
  return prisma.$transaction(async (tx) => {
    const [makeup] = await tx.$queryRawUnsafe<Array<{ status: string; targetType: string }>>(
      `SELECT status, "targetType" FROM "SpecialProgramMakeup" WHERE id = $1 FOR UPDATE`,
      makeupId,
    );
    if (!makeup) throw new Error("MAKEUP_NOT_FOUND");
    if (expectedStatus && makeup.status !== expectedStatus) throw new Error("MAKEUP_STATUS_CONFLICT");

    if (action === "APPROVE") {
      await tx.$executeRawUnsafe(
        `UPDATE "SpecialProgramMakeup" SET status='SCHEDULED', "approvedByUserId"=$2, "decidedAt"=now(), "updatedAt"=now() WHERE id=$1`,
        makeupId, userId ?? null,
      );
      if (makeup.targetType === "SEASONAL") await ensureSeasonalMakeupSlot(makeupId, tx);
      return { ok: true, status: "SCHEDULED" };
    }
    if (action === "REJECT" || action === "CANCEL") {
      const status = action === "REJECT" ? "REJECTED" : "CANCELLED";
      await tx.$executeRawUnsafe(
        `UPDATE "SpecialProgramMakeup" SET status=$2, "approvedByUserId"=$3, "decidedAt"=now(), "updatedAt"=now() WHERE id=$1`,
        makeupId, status, userId ?? null,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "SpecialProgramEnrollmentDate" SET status='CANCELLED', "updatedAt"=now()
          WHERE "makeupId"=$1 AND kind='MAKEUP' AND "attendanceStatus" IS NULL`,
        makeupId,
      );
      return { ok: true, status };
    }
    await tx.$executeRawUnsafe(
      `UPDATE "SpecialProgramMakeup" SET status=$2, "updatedAt"=now() WHERE id=$1`,
      makeupId, action,
    );
    return { ok: true, status: action };
  });
}

// 보강 목록 (승인 대기 + 배정됨)
export async function listMakeups(seasonId?: string | null) {
  const params: any[] = [];
  let seasonWhere = "";
  if (seasonId) { params.push(seasonId); seasonWhere = ` AND o."seasonId" = $1`; }

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT m.id, m.status, m."targetType", m."requestedBy", m."requestedAt",
            a."childName", a."childGrade", o.title AS "offeringTitle", o.capacity,
            absd."startsAt" AS "absentStartsAt",
            tsd."startsAt" AS "targetStartsAt", m."targetSessionDateId",
            c.name AS "targetClassName", m."targetDate", m."targetClassId",
            (SELECT COUNT(*) FROM "SpecialProgramEnrollmentDate" e2 WHERE e2."sessionDateId"=m."targetSessionDateId" AND e2.status='SCHEDULED') AS "targetFilled"
       FROM "SpecialProgramMakeup" m
       JOIN "SpecialProgramApplicationItem" it ON it.id = m."applicationItemId"
       JOIN "SpecialProgramApplication" a ON a.id = it."applicationId"
       JOIN "SpecialProgramOffering" o ON o.id = m."offeringId"
       LEFT JOIN "SpecialProgramSessionDate" absd ON absd.id = m."absentSessionDateId"
       LEFT JOIN "SpecialProgramSessionDate" tsd ON tsd.id = m."targetSessionDateId"
       LEFT JOIN "Class" c ON c.id = m."targetClassId"
      WHERE 1=1${seasonWhere}
      ORDER BY (m.status='REQUESTED') DESC, m."requestedAt" DESC`,
    ...params,
  );

  const map = (r: any) => ({
    id: r.id, status: r.status, targetType: r.targetType, requestedBy: r.requestedBy,
    childName: r.childName, childGrade: r.childGrade ?? null, offeringTitle: r.offeringTitle,
    absentLabel: r.absentStartsAt ? seoulLabel(r.absentStartsAt) : null,
    targetLabel: r.targetType === "SEASONAL"
      ? (r.targetStartsAt ? seoulLabel(r.targetStartsAt) : null)
      : (r.targetClassName ? `${r.targetClassName}${r.targetDate ? " · " + seoulLabel(r.targetDate) : ""}` : null),
    targetCapacity: r.capacity == null ? null : Number(r.capacity),
    targetFilled: r.targetSessionDateId ? num(r.targetFilled) : null,
  });

  const pending = rows.filter((r) => r.status === "REQUESTED").map(map);
  const assigned = rows.filter((r) => ["SCHEDULED", "APPROVED", "ATTENDED", "NO_SHOW"].includes(r.status)).map(map);
  return {
    pending, assigned,
    stats: {
      pending: pending.length,
      scheduled: rows.filter((r) => r.status === "SCHEDULED").length,
      attended: rows.filter((r) => r.status === "ATTENDED").length,
    },
  };
}
