import { childAccessSql } from "@/lib/account/child-access";
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import { todayKst } from "@/lib/datetime/kst";
import { CHANGE_REQUEST_MESSAGE, resolveEffectiveFrom } from "@/lib/enrollment/changeRequestRules";
import {
  CLASS_ADD_KIND,
  CLASS_ADD_MESSAGE,
  classAddCandidateIds,
  validateClassAdd,
  type ClassAddCandidateClass,
} from "@/lib/enrollment/classAddRules";
import { studentMakeupGrade } from "@/lib/makeup/student-grade";

// ── 학부모 «반 추가» 신청(2026-11-14 결정표 c8) ─────────────────────────────────
//
// 지금 다니는 반은 그대로 두고 다른 요일·시간 반을 하나 더. 수강 변경 신청과 같은 표(EnrollmentChangeRequest)에
// kind='CLASS_ADD' 로 쌓여 원장 승인 화면·신청함·학부모 «신청 내역»에 그대로 나온다.
//
// ★ 보안 가드(반드시 유지):
//   1) IDOR — studentId 가 그 부모의 자녀인지 SQL(childAccessSql)로 재검증. 화면이 보낸 값·후보 목록을 믿지 않는다.
//   2) 후보(학년·이미 다니는 반·이미 신청한 반)는 접수 때 «다시» 계산한다 — 목록과 저장이 같은 판정을 탄다.
//   3) 같은 학생의 접수는 학생 행 잠금으로 줄 세운다 — 같은 반을 두 번 신청하는 틈이 없다.

/** 방학특강 반(dayOfWeek='Seasonal')은 별도 신청 흐름이라 제외한다(수강 변경과 같은 기준). */
const REGULAR_CLASS_FILTER = `c."dayOfWeek" <> 'Seasonal'`;

/**
 * 반 + 대상 학년(시간표 학년 구성 → 대상 학년 글자 → 직접 만든 슬롯). 보강 예약 후보 조회와 같은 읽기.
 * 지운 프로그램의 반은 뺀다(반 변경 후보와 같은 기준).
 */
const CLASS_GRADES_SQL = `SELECT c.id AS "classId", c.name AS "className", ss."gradesJSON" AS "gradesJson",
        COALESCE(
          NULLIF(btrim(ss."gradeRange"), ''),
          (SELECT NULLIF(btrim(cs."gradeRange"), '') FROM "CustomClassSlot" cs
            WHERE (cs.id = c."slotKey" OR ('custom-' || cs.id) = c."slotKey") AND cs."isHidden" = false LIMIT 1)
        ) AS "gradeRangeText",
        c.capacity,
        -- 정원 셈은 승인 때(admin-class-add)와 같은 기준: 병합된 옛 학생은 세지 않는다
        (SELECT count(*)::int FROM "Enrollment" x JOIN "Student" xs ON xs.id = x."studentId"
          WHERE x."classId" = c.id AND x.status = 'ACTIVE' AND ${notMergedStudent("xs")}) AS enrolled
   FROM "Class" c
   JOIN "Program" p ON p.id = c."programId"
   LEFT JOIN "ScheduleSlot" ss ON ss."slotKey" = c."slotKey"
  WHERE ${REGULAR_CLASS_FILTER} AND p."deletedAt" IS NULL
  ORDER BY c."dayOfWeek", c."startTime"`;

type ClassGradeRow = { classId: string; className: string; gradesJson: string | null; gradeRangeText: string | null; capacity: number; enrolled: number };
type RawDb = { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> };

function toCandidate(row: ClassGradeRow): ClassAddCandidateClass {
  let grades: string[] = [];
  try {
    const parsed = JSON.parse(row.gradesJson ?? "[]");
    if (Array.isArray(parsed)) grades = parsed.map(String);
  } catch { /* 형식 오류는 빈 배열 */ }
  return { classId: row.classId, className: row.className, grades, gradeRangeText: row.gradeRangeText ?? null };
}

export type ClassAddPending = {
  id: string;
  studentId: string;
  toClassId: string;
  toClassName: string | null;
  effectiveFrom: string;
  waitlisted: boolean;
};

export type ClassAddOptions = {
  /** 학생별 고를 수 있는 반(학년이 포함되는 반이 앞). gradeKnown=false 면 학년을 몰라 거르지 않은 목록 */
  byStudent: Record<string, { classIds: string[]; gradeKnown: boolean }>;
  /** 검토 중인 «반 추가» 신청 — 화면이 그 자리에서 취소할 수 있게 번호까지 */
  pending: ClassAddPending[];
};

const EMPTY_OPTIONS: ClassAddOptions = { byStudent: {}, pending: [] };

/**
 * 수강 변경 화면이 «반 추가» 칸에 쓸 자료. 다니는 반(ACTIVE)이 하나라도 있는 내 아이만.
 * 읽기에 실패해도 화면 전체가 죽지 않게 빈 값으로 돌려준다(반 변경·휴원·퇴원은 그대로 쓸 수 있어야 한다).
 */
export async function getClassAddOptions(parentUserId: string): Promise<ClassAddOptions> {
  try {
    const today = todayKst();
    const access = await childAccessSql("s", "$1");
    const [students, classRows, pending] = await Promise.all([
      prisma.$queryRawUnsafe<Array<{ studentId: string; grade: string | null; birthYmd: string | null; classIds: string[]; hasActive: boolean }>>(
        // birthDate 는 시간대 없는 timestamp(UTC 로 저장) — KST 달력 날짜로 읽으려면 변환을 «두 번» 건다
        `SELECT s.id AS "studentId", s.grade,
                to_char(((s."birthDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul'), 'YYYY-MM-DD') AS "birthYmd",
                array_agg(e."classId") AS "classIds",
                bool_or(e.status = 'ACTIVE') AS "hasActive"
           FROM "Student" s
           JOIN "Enrollment" e ON e."studentId" = s.id AND e.status IN ('ACTIVE','PAUSED')
           JOIN "Class" c ON c.id = e."classId" AND ${REGULAR_CLASS_FILTER}
          WHERE ${access} AND ${notMergedStudent("s")}
          GROUP BY s.id, s.grade, s."birthDate"`,
        parentUserId,
      ),
      prisma.$queryRawUnsafe<ClassGradeRow[]>(CLASS_GRADES_SQL),
      prisma.$queryRawUnsafe<ClassAddPending[]>(
        `SELECT r.id, r."studentId", r."toClassId", tc.name AS "toClassName",
                to_char(r."effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom", r.waitlisted
           FROM "EnrollmentChangeRequest" r
           JOIN "Student" s ON s.id = r."studentId" AND ${notMergedStudent("s")}
           LEFT JOIN "Class" tc ON tc.id = r."toClassId"
          WHERE ${access} AND r.kind = '${CLASS_ADD_KIND}' AND r.status = 'PENDING'
          ORDER BY r."createdAt"`,
        parentUserId,
      ),
    ]);
    const classes = classRows.map(toCandidate);
    const byStudent: ClassAddOptions["byStudent"] = {};
    for (const student of students) {
      if (!student.hasActive) continue; // 휴원 중인 반만 있으면 복귀가 먼저다
      byStudent[student.studentId] = classAddCandidateIds({
        studentGrade: studentMakeupGrade(student.birthYmd ?? null, student.grade, today),
        classes,
        enrolledClassIds: student.classIds ?? [],
        pendingClassIds: pending.filter((p) => p.studentId === student.studentId).map((p) => p.toClassId),
      });
    }
    return {
      byStudent,
      pending: pending.map((p) => ({
        id: p.id, studentId: p.studentId, toClassId: p.toClassId, toClassName: p.toClassName ?? null,
        effectiveFrom: p.effectiveFrom, waitlisted: Boolean(p.waitlisted),
      })),
    };
  } catch (error) {
    // 개인정보·원문 SQL 은 남기지 않는다
    console.error("[parent-class-add] 후보 조회 실패", error instanceof Error ? error.name : "");
    return EMPTY_OPTIONS;
  }
}

export type SubmitClassAddInput = {
  studentId?: unknown;
  toClassId?: unknown;
  /** 시작일(내일 이후·3개월 이내 — 반 변경과 같은 범위). 비우면 다음 달 1일. */
  effectiveFrom?: unknown;
  reason?: unknown;
};

export async function submitClassAddRequest(parentUserId: string, input: SubmitClassAddInput) {
  const studentId = typeof input.studentId === "string" ? input.studentId.trim() : "";
  if (!studentId) return { ok: false as const, message: "아이를 다시 선택해 주세요." };

  // 시작일은 반 변경과 같은 규칙 함수가 정한다(내일 이후·3개월 이내, 벗어나면 조용히 바꾸지 않고 거절).
  const today = todayKst();
  const resolved = resolveEffectiveFrom({ kind: "CLASS_CHANGE", requestedFrom: input.effectiveFrom, today });
  if (!resolved.ok) return { ok: false as const, message: CHANGE_REQUEST_MESSAGE[resolved.error] };
  const effectiveFrom = resolved.effectiveFrom;

  const access = await childAccessSql("s", "$2");
  const result = await prisma.$transaction(async (tx: RawDb) => {
    // 가드1 + 줄 세우기: 내 아이인지 확인하면서 학생 행을 잠근다(같은 학생의 동시 접수가 차례로 들어온다).
    const students = await tx.$queryRawUnsafe<Array<{ id: string; name: string; grade: string | null; birthYmd: string | null }>>(
      `SELECT s.id, s.name, s.grade,
              to_char(((s."birthDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul'), 'YYYY-MM-DD') AS "birthYmd"
         FROM "Student" s
        WHERE s.id = $1 AND ${access} AND ${notMergedStudent("s")}
        FOR UPDATE OF s`,
      studentId, parentUserId,
    );
    const student = students[0];
    if (!student) return { ok: false as const, message: "본인 자녀만 반 추가를 신청할 수 있습니다." };

    const enrollments = await tx.$queryRawUnsafe<Array<{ classId: string; status: string; className: string }>>(
      `SELECT e."classId", e.status, c.name AS "className"
         FROM "Enrollment" e JOIN "Class" c ON c.id = e."classId" AND ${REGULAR_CLASS_FILTER}
        WHERE e."studentId" = $1 AND e.status IN ('ACTIVE','PAUSED')`,
      studentId,
    );
    const pendingRows = await tx.$queryRawUnsafe<Array<{ toClassId: string }>>(
      `SELECT "toClassId" FROM "EnrollmentChangeRequest"
        WHERE "studentId" = $1 AND kind = '${CLASS_ADD_KIND}' AND status = 'PENDING' AND "toClassId" IS NOT NULL`,
      studentId,
    );
    // 하루 상한(L1): 오늘(KST) 이 아이로 낸 반 추가 신청 수 — 취소한 것도 센다. createdAt 은 timestamptz 라 변환은 한 번.
    // 학생 행을 잠근 뒤에 세므로 동시에 여러 번 눌러도 상한을 넘지 못한다.
    const [today_] = await tx.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "EnrollmentChangeRequest"
        WHERE "studentId" = $1 AND kind = '${CLASS_ADD_KIND}'
          AND ("createdAt" AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date`,
      studentId,
    );
    const classRows = await tx.$queryRawUnsafe<ClassGradeRow[]>(CLASS_GRADES_SQL);
    const pendingClassIds = pendingRows.map((row) => row.toClassId);
    const candidates = classAddCandidateIds({
      studentGrade: studentMakeupGrade(student.birthYmd ?? null, student.grade, today),
      classes: classRows.map(toCandidate),
      enrolledClassIds: enrollments.map((row) => row.classId),
      pendingClassIds,
    });
    const wanted = typeof input.toClassId === "string" ? input.toClassId.trim() : "";
    const target = classRows.find((row) => row.classId === wanted) ?? null;
    const checked = validateClassAdd({
      toClassId: input.toClassId, reason: input.reason,
      enrollments, pendingClassIds, targetExists: Boolean(target), candidateIds: candidates.classIds,
      todayCount: Number(today_?.n ?? 0),
    });
    if (!checked.ok) {
      return { ok: false as const, message: CLASS_ADD_MESSAGE[checked.error], ...(checked.error === "DAILY_LIMIT" ? { code: "DAILY_LIMIT" as const } : {}) };
    }

    // 정원이 찬 반도 받는다(반 변경과 같은 대기 규칙) — 원장 화면에 «희망 반 만석»으로 보인다.
    const waitlisted = Number(target!.enrolled ?? 0) >= Number(target!.capacity ?? 0);
    const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) || null : null;
    const requestId = crypto.randomUUID();
    // 떠나는 반이 없으므로 enrollmentId·fromClassId 는 비운다(= 수강 등록당 «검토 중 1건» 제약과 무관).
    await tx.$queryRawUnsafe(
      `INSERT INTO "EnrollmentChangeRequest"
          ("studentId","enrollmentId","fromClassId","toClassId","kind","effectiveFrom",
           "resumeOn","reason","waitlisted","requestedByUserId",id)
       VALUES ($1,NULL,NULL,$2,'${CLASS_ADD_KIND}',$3::date,NULL,$4,$5,$6,$7)
       RETURNING id`,
      studentId, checked.toClassId, effectiveFrom, reason, waitlisted, parentUserId, requestId,
    );
    return {
      ok: true as const, id: requestId, kind: CLASS_ADD_KIND, effectiveFrom, resumeOn: null,
      toClassId: checked.toClassId, toClassName: target!.className, waitlisted,
      studentName: student.name,
      currentClassNames: enrollments.filter((row) => row.status === "ACTIVE").map((row) => row.className),
      anchorClassId: enrollments.find((row) => row.status === "ACTIVE")?.classId ?? null,
    };
  });
  if (!result.ok) return result;

  // 원장 알림 — 수강 변경 신청과 같은 경로(앱 알림). 실패해도 신청은 남는다.
  try {
    const { notifyOperationalStaff } = await import("@/lib/operational-staff-notification");
    await notifyOperationalStaff({
      type: "ENROLLMENT_CHANGE",
      title: "수강 변경 신청",
      message: `${result.studentName} 학생 반 추가 신청 (${result.toClassName}, ${result.effectiveFrom}부터)`
        + (result.waitlisted ? " · 희망 반 정원이 찼습니다" : "")
        + " · 승인하면 그 날짜부터 수강이 등록됩니다.",
      linkUrl: "/admin/inbox?tab=CHANGE&sub=ENROLLMENT",
      staffLinkUrl: "/staff",
      classId: result.toClassId,
      includeCoach: false,
    });
  } catch (error) {
    console.error("[parent-class-add] 원장 알림 실패:", error instanceof Error ? error.name : "");
  }

  return {
    ok: true as const, id: result.id, kind: result.kind, effectiveFrom: result.effectiveFrom, resumeOn: null,
    toClassId: result.toClassId, toClassName: result.toClassName, waitlisted: result.waitlisted,
  };
}
