import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import {
  CHANGE_REQUEST_MESSAGE,
  MAX_EFFECTIVE_MONTHS_AHEAD,
  addMonths,
  isChangeKind,
  nextMonthStart,
  resolveEffectiveFrom,
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

function kstTodayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** 내일(YYYY-MM-DD). 말일이면 다음 달 1일이 된다. */
function nextDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

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
  pending: {
    id: string;
    kind: string;
    toClassName: string | null;
    effectiveFrom: string;
    waitlisted: boolean;
  } | null;
};

export type EnrollmentChangeOptions = {
  /** 기본 적용일(다음 달 1일). 반 변경은 학부모가 아래 범위 안에서 바꿀 수 있다. */
  effectiveFrom: string;
  /** 반 변경 시작일로 고를 수 있는 범위 */
  minEffectiveFrom: string;
  maxEffectiveFrom: string;
  children: ChildChangeOption[];
  classes: ChangeableClass[];
};

/** 방학특강 반(dayOfWeek='Seasonal')은 별도 신청 흐름이라 여기서 제외한다. */
const REGULAR_CLASS_FILTER = `c."dayOfWeek" <> 'Seasonal'`;

export async function getEnrollmentChangeOptions(parentUserId: string): Promise<EnrollmentChangeOptions> {
  const today = kstTodayYmd();
  const effectiveFrom = nextMonthStart(today);

  const children = await prisma.$queryRawUnsafe<any[]>(
    `SELECT s.id AS "studentId", s.name AS "studentName",
            e.id AS "enrollmentId", c.id AS "currentClassId",
            c.name AS "currentClassName", p.name AS "currentProgramName",
            r.id AS "pendingId", r.kind AS "pendingKind",
            tc.name AS "pendingToClassName",
            to_char(r."effectiveFrom",'YYYY-MM-DD') AS "pendingEffectiveFrom",
            r.waitlisted AS "pendingWaitlisted"
       FROM "Student" s
       JOIN "Enrollment" e ON e."studentId" = s.id AND e.status = 'ACTIVE'
       JOIN "Class" c ON c.id = e."classId" AND ${REGULAR_CLASS_FILTER}
       JOIN "Program" p ON p.id = c."programId"
       LEFT JOIN "EnrollmentChangeRequest" r
              ON r."enrollmentId" = e.id AND r.status = 'PENDING'
       LEFT JOIN "Class" tc ON tc.id = r."toClassId"
      WHERE s."parentId" = $1 AND ${notMergedStudent("s")}
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
    // 내일 계산이 달을 넘길 수 있어(말일) 안전하게 오늘+1일을 Date 로 구한다.
    minEffectiveFrom: nextDay(today),
    maxEffectiveFrom: addMonths(today, MAX_EFFECTIVE_MONTHS_AHEAD),
    children: children.map((row) => ({
      studentId: row.studentId,
      studentName: row.studentName,
      enrollmentId: row.enrollmentId,
      currentClassId: row.currentClassId,
      currentClassName: row.currentClassName,
      currentProgramName: row.currentProgramName,
      pending: row.pendingId
        ? {
            id: row.pendingId,
            kind: row.pendingKind,
            toClassName: row.pendingToClassName ?? null,
            effectiveFrom: row.pendingEffectiveFrom,
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

  // 가드1: 이 수강 등록이 그 부모의 자녀 것이고 지금 다니는(ACTIVE) 반인지 재검증.
  const owned = await prisma.$queryRawUnsafe<any[]>(
    `SELECT e.id, e."classId", s.id AS "studentId", s.name AS "studentName", c.name AS "className"
       FROM "Enrollment" e
       JOIN "Student" s ON s.id = e."studentId"
       JOIN "Class" c ON c.id = e."classId"
      WHERE e.id = $1 AND s."parentId" = $2 AND e.status = 'ACTIVE' AND ${notMergedStudent("s")}
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
    today: kstTodayYmd(),
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

  await prisma.$executeRawUnsafe(
    `INSERT INTO "EnrollmentChangeRequest"
        ("studentId","enrollmentId","fromClassId","toClassId","kind","effectiveFrom",
         "resumeOn","reason","waitlisted","requestedByUserId")
     VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10)`,
    owned[0].studentId, enrollmentId, owned[0].classId, toClassId, kind, effectiveFrom,
    resumeOn, reason, waitlisted, parentUserId,
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

  return { ok: true as const, effectiveFrom, waitlisted };
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
          AND s."parentId" = $1
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
  kind: ChangeKind;
  effectiveFrom: string;
  waitlisted: boolean;
}) {
  try {
    const { notifyOperationalStaff } = await import("@/lib/operational-staff-notification");
    const { CHANGE_KIND_LABEL } = await import("@/lib/enrollment/changeRequestRules");
    const what =
      input.kind === "CLASS_CHANGE"
        ? `${input.fromClassName} → ${input.toClassName ?? "?"}`
        : input.fromClassName;
    const message =
      `${input.studentName} 학생 ${CHANGE_KIND_LABEL[input.kind]} 신청 (${what}, ${input.effectiveFrom}부터)` +
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
