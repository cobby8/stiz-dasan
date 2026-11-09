import { childAccessSql } from "@/lib/account/child-access";
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import { addDaysKst, todayKst } from "@/lib/datetime/kst";
import {
  CHANGE_REQUEST_MESSAGE,
  MAX_EFFECTIVE_MONTHS_AHEAD,
  addMonths,
  isChangeKind,
  nextMonthStart,
  REQUEST_KIND_LABEL,
  RESUME_KIND,
  resolveEffectiveFrom,
  resolveResumeDate,
  validateChangeRequest,
  type ChangeKind,
} from "@/lib/enrollment/changeRequestRules";

// ── 학부모 수강 변경 신청(반 변경·휴원·퇴원) ────────────────────────────────
//
// ★ 보안 가드(반드시 유지):
//   1) IDOR 방어 — studentId·enrollmentId 가 그 부모(appUserId)의 것인지 SQL 로 재검증.
//      클라이언트가 보낸 값 자체를 신뢰하지 않는다.
//   2) 적용일은 서버가 정한다 — 클라이언트가 보낸 날짜를 믿으면 이번 달로 앞당겨
//      이미 청구된 달의 반을 바꿀 수 있다.
//   3) 진행 중 신청은 수강 등록당 한 건 — DB 부분 유니크 인덱스가 최종 방어선이고,
//      여기서는 사람이 읽을 수 있는 문구로 먼저 걸러낸다.

// 날짜는 공용 모듈(@/lib/datetime/kst)에서만 만든다 — 파일마다 따로 만들면 한쪽만 고쳐지는 사고가 난다.

export type ChangeableClass = {
  classId: string;
  className: string;
  programName: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  capacity: number;
  enrolled: number;
  full: boolean;
};

export type ChildChangeOption = {
  studentId: string;
  studentName: string;
  enrollmentId: string;
  currentClassId: string;
  currentClassName: string;
  currentProgramName: string;
  /** ACTIVE = 다니는 중(반 변경·휴원·퇴원 신청) · PAUSED = 휴원 중(복귀 신청만) */
  enrollmentStatus: "ACTIVE" | "PAUSED";
  /**
   * 원장이 승인했지만 아직 적용일 전인 신청(예: 휴원 예정). 학부모가 직접 취소할 수는 없어 안내만 한다.
   * 적용일이 지난 승인 건은 넣지 않는다 — 사람 확인으로 보류된 건이 화면을 영영 막으면 안 된다.
   */
  scheduled: {
    kind: string;
    effectiveFrom: string;
    resumeOn: string | null;
  } | null;
  pending: {
    id: string;
    kind: string;
    toClassName: string | null;
    effectiveFrom: string;
    resumeOn: string | null;
    waitlisted: boolean;
  } | null;
};

export type EnrollmentChangeOptions = {
  /** 기본 적용일(다음 달 1일). 반 변경은 학부모가 아래 범위 안에서 바꿀 수 있다. */
  effectiveFrom: string;
  /** 반 변경 시작일로 고를 수 있는 범위 */
  minEffectiveFrom: string;
  maxEffectiveFrom: string;
  /** 복귀 희망일로 고를 수 있는 범위(오늘 ~ 3개월). 화면 min/max 와 서버 검사가 같은 값을 본다. */
  minResumeFrom: string;
  maxResumeFrom: string;
  children: ChildChangeOption[];
  classes: ChangeableClass[];
};

/** 방학특강 반(dayOfWeek='Seasonal')은 별도 신청 흐름이라 여기서 제외한다. */
const REGULAR_CLASS_FILTER = `c."dayOfWeek" <> 'Seasonal'`;

export async function getEnrollmentChangeOptions(parentUserId: string): Promise<EnrollmentChangeOptions> {
  const today = todayKst();
  const effectiveFrom = nextMonthStart(today);

  const children = await prisma.$queryRawUnsafe<any[]>(
    `SELECT s.id AS "studentId", s.name AS "studentName",
            e.id AS "enrollmentId", c.id AS "currentClassId",
            c.name AS "currentClassName", p.name AS "currentProgramName",
            r.id AS "pendingId", r.kind AS "pendingKind",
            tc.name AS "pendingToClassName",
            to_char(r."effectiveFrom",'YYYY-MM-DD') AS "pendingEffectiveFrom",
            to_char(r."resumeOn",'YYYY-MM-DD') AS "pendingResumeOn",
            r.waitlisted AS "pendingWaitlisted",
            e.status AS "enrollmentStatus",
            sc.kind AS "scheduledKind",
            to_char(sc."effectiveFrom",'YYYY-MM-DD') AS "scheduledEffectiveFrom",
            to_char(sc."resumeOn",'YYYY-MM-DD') AS "scheduledResumeOn"
       FROM "Student" s
       -- 휴원 중(PAUSED)인 반도 보여 준다. 그래야 그 반에 «복귀 신청»을 낼 수 있다.
       JOIN "Enrollment" e ON e."studentId" = s.id AND e.status IN ('ACTIVE','PAUSED')
       JOIN "Class" c ON c.id = e."classId" AND ${REGULAR_CLASS_FILTER}
       JOIN "Program" p ON p.id = c."programId"
       LEFT JOIN "EnrollmentChangeRequest" r
              ON r."enrollmentId" = e.id AND r.status = 'PENDING'
       LEFT JOIN "Class" tc ON tc.id = r."toClassId"
       -- 승인됐지만 적용일이 아직 안 온 신청 1건(휴원 예정 등). 행이 늘지 않게 LATERAL … LIMIT 1.
       LEFT JOIN LATERAL (
         SELECT x.kind, x."effectiveFrom", x."resumeOn"
           FROM "EnrollmentChangeRequest" x
          WHERE x."enrollmentId" = e.id AND x.status = 'APPROVED' AND x."appliedAt" IS NULL
            AND x."effectiveFrom" > (now() AT TIME ZONE 'Asia/Seoul')::date
          ORDER BY x."effectiveFrom" LIMIT 1
       ) sc ON true
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
      ORDER BY s.name, c."dayOfWeek", c."startTime"`,
    parentUserId,
  );

  const classes = await prisma.$queryRawUnsafe<any[]>(
    // 정원이 찬 반도 함께 내려준다(원장 결정: 대기로 받는다). 화면에서 "대기"로 표시한다.
    `SELECT c.id AS "classId", c.name AS "className", p.name AS "programName",
            c."dayOfWeek", c."startTime", c."endTime", c.capacity,
            (SELECT count(*)::int FROM "Enrollment" x
              WHERE x."classId" = c.id AND x.status = 'ACTIVE') AS enrolled
       FROM "Class" c
       JOIN "Program" p ON p.id = c."programId"
      WHERE ${REGULAR_CLASS_FILTER} AND p."deletedAt" IS NULL
      ORDER BY c."dayOfWeek", c."startTime"`,
  );

  return {
    effectiveFrom,
    // 내일 = 공용 달력 더하기(말일이면 다음 달 1일).
    minEffectiveFrom: addDaysKst(today, 1),
    maxEffectiveFrom: addMonths(today, MAX_EFFECTIVE_MONTHS_AHEAD),
    minResumeFrom: today,
    maxResumeFrom: addMonths(today, MAX_EFFECTIVE_MONTHS_AHEAD),
    children: children.map((row) => ({
      studentId: row.studentId,
      studentName: row.studentName,
      enrollmentId: row.enrollmentId,
      currentClassId: row.currentClassId,
      currentClassName: row.currentClassName,
      currentProgramName: row.currentProgramName,
      enrollmentStatus: row.enrollmentStatus === "PAUSED" ? ("PAUSED" as const) : ("ACTIVE" as const),
      scheduled: row.scheduledKind
        ? {
            kind: row.scheduledKind,
            effectiveFrom: row.scheduledEffectiveFrom,
            resumeOn: row.scheduledResumeOn ?? null,
          }
        : null,
      pending: row.pendingId
        ? {
            id: row.pendingId,
            kind: row.pendingKind,
            toClassName: row.pendingToClassName ?? null,
            effectiveFrom: row.pendingEffectiveFrom,
            resumeOn: row.pendingResumeOn ?? null,
            waitlisted: Boolean(row.pendingWaitlisted),
          }
        : null,
    })),
    classes: classes.map((row) => ({
      classId: row.classId,
      className: row.className,
      programName: row.programName,
      dayOfWeek: row.dayOfWeek,
      startTime: row.startTime,
      endTime: row.endTime,
      capacity: Number(row.capacity ?? 0),
      enrolled: Number(row.enrolled ?? 0),
      full: Number(row.enrolled ?? 0) >= Number(row.capacity ?? 0),
    })),
  };
}

export type SubmitChangeInput = {
  enrollmentId?: string;
  kind?: unknown;
  /** 반 변경일 때만. 학부모가 고른 시작일(내일 이후·3개월 이내). 비우면 다음 달 1일. */
  effectiveFrom?: unknown;
  toClassId?: unknown;
  resumeOn?: unknown;
  reason?: unknown;
};

export async function submitEnrollmentChangeRequest(parentUserId: string, input: SubmitChangeInput) {
  const enrollmentId = typeof input.enrollmentId === "string" ? input.enrollmentId.trim() : "";
  if (!enrollmentId) return { ok: false as const, message: "수강 정보를 다시 선택해 주세요." };

  // 복귀 신청은 출발 상태(PAUSED)가 달라 따로 처리한다. 가드는 아래와 같은 세 가지다.
  if (input.kind === RESUME_KIND) return submitResumeRequest(parentUserId, enrollmentId, input);

  // 가드1: 이 수강 등록이 그 부모의 자녀 것이고 지금 다니는(ACTIVE) 반인지 재검증.
  const owned = await prisma.$queryRawUnsafe<any[]>(
    `SELECT e.id, e."classId", s.id AS "studentId", s.name AS "studentName", c.name AS "className"
       FROM "Enrollment" e
       JOIN "Student" s ON s.id = e."studentId"
       JOIN "Class" c ON c.id = e."classId"
      WHERE e.id = $1 AND ${await childAccessSql("s", "$2")} AND e.status = 'ACTIVE' AND ${notMergedStudent("s")}
      LIMIT 1`,
    enrollmentId, parentUserId,
  );
  if (!owned[0]) return { ok: false as const, message: "본인 자녀의 수강만 변경 신청할 수 있습니다." };

  // 가드2: 적용일은 서버가 정한다. 학부모가 고른 날짜도 규칙(내일 이후·3개월 이내)을
  // 통과해야 하고, 벗어나면 조용히 바꾸지 않고 거절한다.
  if (!isChangeKind(input.kind)) {
    return { ok: false as const, message: CHANGE_REQUEST_MESSAGE.INVALID_KIND };
  }
  const resolved = resolveEffectiveFrom({
    kind: input.kind,
    requestedFrom: input.effectiveFrom,
    today: todayKst(),
  });
  if (!resolved.ok) return { ok: false as const, message: CHANGE_REQUEST_MESSAGE[resolved.error] };
  const effectiveFrom = resolved.effectiveFrom;

  const checked = validateChangeRequest(input, { currentClassId: owned[0].classId, effectiveFrom });
  if (!checked.ok) return { ok: false as const, message: CHANGE_REQUEST_MESSAGE[checked.error] };
  const kind: ChangeKind = checked.kind;

  // 가드3: 진행 중인 신청이 이미 있으면 먼저 취소하게 한다(DB 부분 유니크가 최종 방어선).
  const existing = await prisma.$queryRawUnsafe<any[]>(
    `SELECT 1 FROM "EnrollmentChangeRequest" WHERE "enrollmentId" = $1 AND status = 'PENDING' LIMIT 1`,
    enrollmentId,
  );
  if (existing.length > 0) {
    return { ok: false as const, message: "이미 검토 중인 신청이 있습니다. 취소한 뒤 다시 신청해 주세요." };
  }

  let toClassId: string | null = null;
  let waitlisted = false;
  let toClassName: string | null = null;
  if (kind === "CLASS_CHANGE") {
    toClassId = String(input.toClassId).trim();
    // 희망 반이 실재하는 정규 반인지 + 지금 몇 명인지 확인. 만석이어도 대기로 받는다.
    const target = await prisma.$queryRawUnsafe<any[]>(
      `SELECT c.id, c.name, c.capacity,
              (SELECT count(*)::int FROM "Enrollment" x
                WHERE x."classId" = c.id AND x.status = 'ACTIVE') AS enrolled
         FROM "Class" c
        WHERE c.id = $1 AND ${REGULAR_CLASS_FILTER}
        LIMIT 1`,
      toClassId,
    );
    if (!target[0]) return { ok: false as const, message: "선택한 반을 찾을 수 없습니다." };
    waitlisted = Number(target[0].enrolled ?? 0) >= Number(target[0].capacity ?? 0);
    toClassName = target[0].name;
  }

  const resumeOn = kind === "PAUSE" && input.resumeOn ? String(input.resumeOn) : null;
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) || null : null;

  // id 를 여기서 만들어 돌려준다 — 화면이 새로고침을 기다리지 않고 «검토 중 + 취소 버튼»을 바로 보여 준다.
  const requestId = crypto.randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "EnrollmentChangeRequest"
        ("studentId","enrollmentId","fromClassId","toClassId","kind","effectiveFrom",
         "resumeOn","reason","waitlisted","requestedByUserId",id)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11)`,
    owned[0].studentId, enrollmentId, owned[0].classId, toClassId, kind, effectiveFrom,
    resumeOn, reason, waitlisted, parentUserId, requestId,
  );

  await notifyAdminsOfChangeRequest({
    studentName: owned[0].studentName,
    fromClassName: owned[0].className,
    fromClassId: owned[0].classId,
    toClassName,
    kind,
    effectiveFrom,
    waitlisted,
  });

  return { ok: true as const, id: requestId, kind, effectiveFrom, resumeOn, toClassName, waitlisted };
}

/**
 * 복귀 신청(RESUME) — 휴원 중인 반을 다시 다니겠다는 신청. 원장이 승인하면 복귀일에 사이트 수강이 ACTIVE 로 돌아간다.
 * 가드1: 그 부모의 자녀 수강이고 지금 휴원(PAUSED) 중인지 SQL 로 재검증(IDOR).
 * 가드2: 복귀일은 오늘(KST) ~ 3개월 — 규칙 함수 한 곳(resolveResumeDate)이 판정한다.
 * 가드3: 진행 중 신청은 수강 등록당 한 건(DB 부분 유니크가 최종 방어선).
 */
async function submitResumeRequest(parentUserId: string, enrollmentId: string, input: SubmitChangeInput) {
  const owned = await prisma.$queryRawUnsafe<any[]>(
    `SELECT e.id, e."classId", s.id AS "studentId", s.name AS "studentName", c.name AS "className"
       FROM "Enrollment" e
       JOIN "Student" s ON s.id = e."studentId"
       JOIN "Class" c ON c.id = e."classId"
      WHERE e.id = $1 AND ${await childAccessSql("s", "$2")} AND e.status = 'PAUSED' AND ${notMergedStudent("s")}
      LIMIT 1`,
    enrollmentId, parentUserId,
  );
  if (!owned[0]) return { ok: false as const, message: "휴원 중인 본인 자녀의 반만 복귀 신청할 수 있습니다." };

  // 복귀 신청에는 희망 반이 없다. 붙어 오면 화면과 서버가 어긋난 것이라 조용히 무시하지 않는다.
  if (input.toClassId) return { ok: false as const, message: CHANGE_REQUEST_MESSAGE.TO_CLASS_NOT_ALLOWED };
  if (typeof input.reason === "string" && input.reason.length > 500) {
    return { ok: false as const, message: CHANGE_REQUEST_MESSAGE.REASON_TOO_LONG };
  }
  // 복귀 희망일은 effectiveFrom 으로 받는다(= 다시 다니기 시작하는 날).
  const resolved = resolveResumeDate({ requested: input.effectiveFrom, today: todayKst() });
  if (!resolved.ok) return { ok: false as const, message: CHANGE_REQUEST_MESSAGE[resolved.error] };
  const effectiveFrom = resolved.resumeFrom;

  const existing = await prisma.$queryRawUnsafe<any[]>(
    `SELECT 1 FROM "EnrollmentChangeRequest" WHERE "enrollmentId" = $1 AND status = 'PENDING' LIMIT 1`,
    enrollmentId,
  );
  if (existing.length > 0) {
    return { ok: false as const, message: "이미 검토 중인 신청이 있습니다. 취소한 뒤 다시 신청해 주세요." };
  }

  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) || null : null;
  const requestId = crypto.randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "EnrollmentChangeRequest"
        ("studentId","enrollmentId","fromClassId","toClassId","kind","effectiveFrom",
         "resumeOn","reason","waitlisted","requestedByUserId",id)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11)`,
    owned[0].studentId, enrollmentId, owned[0].classId, null, RESUME_KIND, effectiveFrom,
    null, reason, false, parentUserId, requestId,
  );

  // 원장 알림 = 휴원 신청과 같은 경로.
  await notifyAdminsOfChangeRequest({
    studentName: owned[0].studentName,
    fromClassName: owned[0].className,
    fromClassId: owned[0].classId,
    toClassName: null,
    kind: RESUME_KIND,
    effectiveFrom,
    waitlisted: false,
  });

  return { ok: true as const, id: requestId, kind: RESUME_KIND, effectiveFrom, resumeOn: null, toClassName: null, waitlisted: false };
}

export async function cancelEnrollmentChangeRequest(parentUserId: string, requestId: string) {
  const id = requestId?.trim();
  if (!id) return { ok: false as const, message: "취소할 신청을 찾을 수 없습니다." };

  // 원장이 이미 결정한 건은 학부모가 되돌릴 수 없다(PENDING 만 취소 가능).
  const canceled = Number(
    await prisma.$executeRawUnsafe(
      `UPDATE "EnrollmentChangeRequest" r
          SET status = 'CANCELED', "updatedAt" = now()
         FROM "Student" s
        WHERE r."studentId" = s.id
          AND ${await childAccessSql("s", "$1")}
          AND r.id = $2
          AND r.status = 'PENDING'`,
      parentUserId, id,
    ),
  );
  if (canceled === 0) return { ok: false as const, message: "이미 처리된 신청은 취소할 수 없습니다." };
  return { ok: true as const };
}

/**
 * 신청이 들어온 것을 원장에게 알린다.
 * 알림 실패가 신청을 되돌리면 안 된다 — 학부모는 이미 신청을 마쳤다.
 */
async function notifyAdminsOfChangeRequest(input: {
  studentName: string;
  fromClassName: string;
  fromClassId: string;
  toClassName: string | null;
  kind: ChangeKind | typeof RESUME_KIND;
  effectiveFrom: string;
  waitlisted: boolean;
}) {
  try {
    const { notifyOperationalStaff } = await import("@/lib/operational-staff-notification");
    const what =
      input.kind === "CLASS_CHANGE"
        ? `${input.fromClassName} → ${input.toClassName ?? "?"}`
        : input.fromClassName;
    const message =
      `${input.studentName} 학생 ${REQUEST_KIND_LABEL[input.kind] ?? "수강 변경"} 신청 (${what}, ${input.effectiveFrom}부터)` +
      (input.waitlisted ? " · 희망 반 정원이 찼습니다" : "");
    await notifyOperationalStaff({
      type: "ENROLLMENT_CHANGE",
      title: "수강 변경 신청",
      message: `${message} · 관리자 승인 전에는 수업·차량표를 변경하지 마세요.`,
      linkUrl: "/admin/enrollment-changes",
      staffLinkUrl: "/staff",
      classId: input.fromClassId,
      includeCoach: true,
    });
  } catch (error) {
    console.error("[parent-change-request] 원장 알림 실패:", error);
  }
}
