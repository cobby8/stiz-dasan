import { childAccessSql } from "@/lib/account/child-access";
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
// 학부모 응답의 남은 자리는 숫자 대신 3단계(재원생 수 비공개 · 2026-11-13 f9)
import { seatLevelFromCounts, type SeatLevel } from "@/lib/seats/seatLevel";
import { addDaysKst, kstHm, todayKst } from "@/lib/datetime/kst";
import {
  CHANGE_REQUEST_MESSAGE,
  MAX_EFFECTIVE_MONTHS_AHEAD,
  MAX_PAUSE_CLASSES_PER_REQUEST,
  addMonths,
  earliestPauseStart,
  isChangeKind,
  nextMonthStart,
  REQUEST_KIND_LABEL,
  RESUME_KIND,
  resolveEffectiveFrom,
  resolveResumeDate,
  validateChangeRequest,
  type ChangeKind,
} from "@/lib/enrollment/changeRequestRules";
import {
  buildClassStatusLine,
  canRequestScheduledCancel,
  scheduledCancelLine,
  type ClassStatusTone,
  type ScheduledCancelInfo,
} from "@/lib/enrollment/parentChangeStatus";

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
  /** 남은 자리 3단계 — 정원·인원 숫자는 학부모 응답에 싣지 않는다(신청 시 서버가 숫자로 다시 검사) */
  seatLevel: SeatLevel;
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
   * 휴원 시작일로 고를 수 있는 가장 이른 날(2026-11-10 원장 결정 m7) — 오늘 그 반 수업 전이면 오늘, 아니면 내일.
   * 서버 접수도 같은 함수(earliestPauseStart)로 다시 판정한다. 옛 데이터·테스트에서 없을 수 있어 선택 칸.
   */
  minPauseFrom?: string;
  /**
   * 원장이 승인했지만 아직 적용일 전인 신청(예: 휴원 예정). 학부모가 직접 취소할 수는 없어 안내만 한다.
   * 적용일이 지난 승인 건은 넣지 않는다 — 사람 확인으로 보류된 건이 화면을 영영 막으면 안 된다.
   */
  scheduled: {
    kind: string;
    effectiveFrom: string;
    resumeOn: string | null;
    /** 그 승인 건의 신청 번호 — 이 화면에서 바로 «취소 요청»을 보낼 때 쓴다(2026-11-14 결정표 c2). 옛 자료·테스트에는 없을 수 있다. */
    id?: string;
    /** [취소 요청] 버튼을 보일까 — 수업 탭 «신청 내역»과 같은 판정(canRequestScheduledCancel) */
    canRequestCancel?: boolean;
    /** 이미 낸 취소 요청의 상태 한 줄(확인 중·받아들여지지 않음) — 수업 탭과 같은 문구. 없으면 null */
    cancelLine?: string | null;
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
  canGroupPause?: boolean;
  /** 최근 3개월 결과(승인·반영·거절·취소). 거절이면 원장 사유(decisionNote)가 함께 온다. */
  history: ChangeHistoryRow[];
};

export type ChangeHistoryRow = {
  id: string;
  studentId: string;
  studentName: string;
  kind: string;
  /** APPROVED | APPLIED | REJECTED | CANCELED */
  status: string;
  /** APPROVED 인데 반영까지 끝난 건(반 변경 마무리 등) — «반영 완료»로 보인다 */
  applied: boolean;
  fromClassName: string | null;
  toClassName: string | null;
  effectiveFrom: string;
  /** 결정(또는 마지막 변경)일 KST "YYYY-MM-DD" */
  decidedOn: string;
  /** 거절 사유 — 거절 건에만 채운다(승인 메모는 내부용일 수 있어 내보내지 않는다) */
  decisionNote: string | null;
  /** 휴원 복귀 예정일 */
  resumeOn: string | null;
  /** 신청일 KST "YYYY-MM-DD" */
  createdOn: string;
  /** 신청 정렬용(ISO 시각) */
  createdAt: string;
  /** 승인된 휴원·퇴원의 학부모 취소 요청(d8) — withCancelRequest 로 읽을 때만 채운다 */
  cancelRequest?: { status: "PENDING" | "APPROVED" | "REJECTED"; requestedOn: string | null; decisionNote: string | null } | null;
};

/** 방학특강 반(dayOfWeek='Seasonal')은 별도 신청 흐름이라 여기서 제외한다. */
const REGULAR_CLASS_FILTER = `c."dayOfWeek" <> 'Seasonal'`;
const PAUSE_GROUP_AVAILABLE_SQL = `EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'EnrollmentChangeRequest'
     AND column_name = 'submissionGroupId'
)`;

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
            c."dayOfWeek" AS "classDayOfWeek", c."startTime" AS "classStartTime",
            ${PAUSE_GROUP_AVAILABLE_SQL} AS "canGroupPause",
            sc.kind AS "scheduledKind",
            to_char(sc."effectiveFrom",'YYYY-MM-DD') AS "scheduledEffectiveFrom",
            to_char(sc."resumeOn",'YYYY-MM-DD') AS "scheduledResumeOn",
            sc.id AS "scheduledId", sc."cancelRequestStatus" AS "scheduledCancelStatus",
            sc."cancelRequestedOn" AS "scheduledCancelRequestedOn", sc."cancelDecisionNote" AS "scheduledCancelNote"
       FROM "Student" s
       -- 휴원 중(PAUSED)인 반도 보여 준다. 그래야 그 반에 «복귀 신청»을 낼 수 있다.
       JOIN "Enrollment" e ON e."studentId" = s.id AND e.status IN ('ACTIVE','PAUSED') AND ${notMergedStudent("s")}
       JOIN "Class" c ON c.id = e."classId" AND ${REGULAR_CLASS_FILTER}
       JOIN "Program" p ON p.id = c."programId"
       LEFT JOIN "EnrollmentChangeRequest" r
              ON r."enrollmentId" = e.id AND r.status = 'PENDING'
       LEFT JOIN "Class" tc ON tc.id = r."toClassId"
       -- 승인됐지만 적용일이 아직 안 온 신청 1건(휴원 예정 등). 행이 늘지 않게 LATERAL … LIMIT 1.
       LEFT JOIN LATERAL (
         -- 취소 요청 칸은 to_jsonb 로 읽는다 — 칸이 아직 없는 DB 에서도 조회가 죽지 않고 «요청 없음»으로 읽힌다.
         SELECT x.id, x.kind, x."effectiveFrom", x."resumeOn",
                to_jsonb(x)->>'cancelRequestStatus' AS "cancelRequestStatus",
                to_jsonb(x)->>'cancelDecisionNote' AS "cancelDecisionNote",
                -- cancelRequestedAt 은 timestamptz 라 AT TIME ZONE 한 번이면 KST 날짜다.
                to_char((to_jsonb(x)->>'cancelRequestedAt')::timestamptz AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "cancelRequestedOn"
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

  const history = await getEnrollmentChangeHistory(parentUserId);
  // 휴원 시작일 최소값은 반마다 다르다(그 반 수업이 오늘 이미 시작했는지). 지금 KST 시각 한 번만 읽는다.
  const nowHm = kstHm(Date.now());

  return {
    history,
    canGroupPause: children[0]?.canGroupPause === true,
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
      minPauseFrom: earliestPauseStart({ today, nowHm, classDayOfWeek: row.classDayOfWeek, classStartTime: row.classStartTime }),
      scheduled: row.scheduledKind ? scheduledOf(row, today) : null,
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
      seatLevel: seatLevelFromCounts(Number(row.capacity ?? 0), Number(row.enrolled ?? 0)),
      full: Number(row.enrolled ?? 0) >= Number(row.capacity ?? 0),
    })),
  };
}

/**
 * «예정»(승인됐지만 적용 전) 한 건 — 신청 번호와 취소 요청 상태를 함께 싣는다(2026-11-14 결정표 c2).
 * 버튼을 보일지·상태 문구는 수업 탭 «신청 내역»과 같은 규칙 함수가 정한다(parentChangeStatus).
 */
function scheduledOf(row: any, today: string): NonNullable<ChildChangeOption["scheduled"]> {
  const cancelRequest: ScheduledCancelInfo | null = ["PENDING", "APPROVED", "REJECTED"].includes(row.scheduledCancelStatus)
    ? { status: row.scheduledCancelStatus, requestedOn: row.scheduledCancelRequestedOn ?? null, decisionNote: row.scheduledCancelNote ?? null }
    : null;
  const id = typeof row.scheduledId === "string" && row.scheduledId ? row.scheduledId : undefined;
  return {
    kind: row.scheduledKind,
    effectiveFrom: row.scheduledEffectiveFrom,
    resumeOn: row.scheduledResumeOn ?? null,
    id,
    // 신청 번호를 모르면(옛 자료) 버튼을 보이지 않는다 — 누를 수 없는 버튼을 만들지 않는다.
    canRequestCancel: Boolean(id) && canRequestScheduledCancel(
      { kind: row.scheduledKind, effectiveFrom: row.scheduledEffectiveFrom, applied: false }, cancelRequest, today,
    ),
    cancelLine: scheduledCancelLine(cancelRequest),
  };
}

/**
 * 최근 3개월 수강 변경 결과(한 줄씩 보여 줄 것). 학부모가 거절 사유를 볼 수 있는 유일한 곳이다.
 * ★ 가드: childAccessSql(그 부모의 자녀만) + notMergedStudent(병합된 옛 학생 제외).
 */
export async function getEnrollmentChangeHistory(
  parentUserId: string,
  // includeOpen: 검토 중(PENDING)·적용 전 승인 건도 함께 — «수업» 탭 신청 내역 타임라인용(2026-11-10).
  //              기본값(false)은 예전 «지난 결과» 그대로.
  // withCancelRequest: 취소 요청(d8) 칸도 읽는다 — 마이그레이션 20261110130000 이후에만 켠다.
  options: { includeOpen?: boolean; withCancelRequest?: boolean } = {},
): Promise<ChangeHistoryRow[]> {
  const cancelCols = options.withCancelRequest
    ? `, r."cancelRequestStatus",
            to_char(r."cancelRequestedAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "cancelRequestedOn",
            r."cancelDecisionNote"`
    : "";
  // SUPERSEDED(학원이 직접 변경해 정리한 신청, 2026-11-14)도 결과로 보여 준다 — 빼면 학부모 신청이 말없이 사라진다
  const statuses = options.includeOpen
    ? `('PENDING','APPROVED','APPLIED','REJECTED','CANCELED','SUPERSEDED')`
    : `('APPROVED','APPLIED','REJECTED','CANCELED','SUPERSEDED')`;
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT r.id, r."studentId", s.name AS "studentName", r.kind, r.status, (r."appliedAt" IS NOT NULL) AS applied,
            to_char(r."resumeOn",'YYYY-MM-DD') AS "resumeOn",
            to_char(r."createdAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "createdOn",
            r."createdAt"${cancelCols},
            fc.name AS "fromClassName", tc.name AS "toClassName",
            to_char(r."effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom",
            -- decidedAt·updatedAt 은 timestamptz 라 AT TIME ZONE 한 번이면 KST 날짜다.
            to_char(COALESCE(r."decidedAt", r."updatedAt") AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "decidedOn",
            CASE WHEN r.status = 'REJECTED' THEN r."decisionNote" ELSE NULL END AS "decisionNote"
       FROM "EnrollmentChangeRequest" r
       JOIN "Student" s ON s.id = r."studentId" AND ${notMergedStudent("s")}
       LEFT JOIN "Class" fc ON fc.id = r."fromClassId"
       LEFT JOIN "Class" tc ON tc.id = r."toClassId"
      WHERE ${await childAccessSql("s", "$1")}
        AND r.status IN ${statuses}
        -- 최근 3개월 + (타임라인이면) 아직 끝나지 않은 건은 오래돼도 보인다
        AND (r."updatedAt" >= now() - interval '3 months'
             OR ($2::boolean AND (r.status = 'PENDING' OR (r.status = 'APPROVED' AND r."appliedAt" IS NULL))))
      ORDER BY r."updatedAt" DESC
      LIMIT 30`,
    parentUserId, Boolean(options.includeOpen),
  );
  return rows.map((row) => ({
    id: row.id,
    studentId: row.studentId,
    studentName: row.studentName,
    kind: row.kind,
    status: row.status,
    applied: Boolean(row.applied),
    fromClassName: row.fromClassName ?? null,
    toClassName: row.toClassName ?? null,
    effectiveFrom: row.effectiveFrom,
    decidedOn: row.decidedOn,
    decisionNote: row.decisionNote ?? null,
    resumeOn: row.resumeOn ?? null,
    createdOn: row.createdOn,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt ?? ""),
    cancelRequest: options.withCancelRequest && ["PENDING", "APPROVED", "REJECTED"].includes(row.cancelRequestStatus)
      ? { status: row.cancelRequestStatus, requestedOn: row.cancelRequestedOn ?? null, decisionNote: row.cancelDecisionNote ?? null }
      : null,
  }));
}

export type ParentClassStatusLine = {
  studentId: string;
  enrollmentId: string;
  className: string;
  text: string;
  tone: ClassStatusTone;
};

/**
 * 학부모 홈 «반 상태 한 줄» — 휴원 예정·검토 중·휴원 중인 반만 돌려준다(그냥 다니는 반은 빠진다).
 * getMyPageData(수강 중 = ACTIVE 만)를 바꾸지 않으려고 따로 조회한다 — 휴원 중(PAUSED) 반도 여기서 보인다.
 * ★ 가드: childAccessSql + notMergedStudent. 다음 단계 «수업» 탭 반 카드 상태 칩도 이 함수/규칙을 쓴다.
 */
export async function getParentClassStatusLines(parentUserId: string): Promise<ParentClassStatusLine[]> {
  const today = todayKst();
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT s.id AS "studentId", e.id AS "enrollmentId", e.status AS "enrollmentStatus", c.name AS "className",
            sc.kind AS "scheduledKind", to_char(sc."effectiveFrom",'YYYY-MM-DD') AS "scheduledFrom",
            to_char(sc."resumeOn",'YYYY-MM-DD') AS "scheduledResumeOn",
            pr.kind AS "pendingKind", to_char(pr."effectiveFrom",'YYYY-MM-DD') AS "pendingFrom",
            to_char(pz."resumeOn",'YYYY-MM-DD') AS "pausedResumeOn"
       FROM "Student" s
       JOIN "Enrollment" e ON e."studentId" = s.id AND e.status IN ('ACTIVE','PAUSED') AND ${notMergedStudent("s")}
       JOIN "Class" c ON c.id = e."classId" AND ${REGULAR_CLASS_FILTER}
       -- 승인됐지만 아직 반영 전인 신청 중 가장 이른 1건
       LEFT JOIN LATERAL (
         SELECT x.kind, x."effectiveFrom", x."resumeOn" FROM "EnrollmentChangeRequest" x
          WHERE x."enrollmentId" = e.id AND x.status = 'APPROVED' AND x."appliedAt" IS NULL
          ORDER BY x."effectiveFrom" LIMIT 1
       ) sc ON true
       -- 검토 중 신청(수강 등록당 1건 — DB 부분 유니크)
       LEFT JOIN LATERAL (
         SELECT x.kind, x."effectiveFrom" FROM "EnrollmentChangeRequest" x
          WHERE x."enrollmentId" = e.id AND x.status = 'PENDING'
          ORDER BY x."createdAt" DESC LIMIT 1
       ) pr ON true
       -- 휴원 중이면 마지막으로 반영된 휴원 신청의 복귀 예정일
       LEFT JOIN LATERAL (
         SELECT x."resumeOn" FROM "EnrollmentChangeRequest" x
          WHERE e.status = 'PAUSED' AND x."enrollmentId" = e.id AND x.kind = 'PAUSE' AND x.status = 'APPLIED'
          ORDER BY x."appliedAt" DESC NULLS LAST LIMIT 1
       ) pz ON true
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
        AND (e.status = 'PAUSED' OR sc.kind IS NOT NULL OR pr.kind IS NOT NULL)
      ORDER BY s.name, c."dayOfWeek", c."startTime"`,
    parentUserId,
  );
  const lines: ParentClassStatusLine[] = [];
  for (const row of rows) {
    const line = buildClassStatusLine({
      enrollmentStatus: row.enrollmentStatus,
      scheduled: row.scheduledKind
        ? { kind: row.scheduledKind, effectiveFrom: row.scheduledFrom, resumeOn: row.scheduledResumeOn ?? null }
        : null,
      pending: row.pendingKind ? { kind: row.pendingKind, effectiveFrom: row.pendingFrom } : null,
      pausedResumeOn: row.pausedResumeOn ?? null,
      today,
    });
    if (line) lines.push({ studentId: row.studentId, enrollmentId: row.enrollmentId, className: row.className, ...line });
  }
  return lines;
}

export type SubmitChangeInput = {
  enrollmentId?: string;
  enrollmentIds?: unknown;
  kind?: unknown;
  /** 반 변경: 학부모가 고른 시작일(내일 이후·3개월 이내) · 휴원: 오늘(수업 전)/내일 이후·3개월 이내. 비우면 다음 달 1일. */
  effectiveFrom?: unknown;
  toClassId?: unknown;
  resumeOn?: unknown;
  reason?: unknown;
};

export async function submitEnrollmentChangeRequest(parentUserId: string, input: SubmitChangeInput) {
  const enrollmentId = typeof input.enrollmentId === "string" ? input.enrollmentId.trim() : "";
  if (!enrollmentId) return { ok: false as const, message: "수강 정보를 다시 선택해 주세요." };
  if (input.enrollmentIds !== undefined) {
    const ids = Array.isArray(input.enrollmentIds)
      ? input.enrollmentIds.map((id) => typeof id === "string" ? id.trim() : "")
      : [];
    if (input.kind !== "PAUSE" || !ids.includes(enrollmentId) || ids.includes("") || new Set(ids).size !== ids.length) {
      return { ok: false as const, message: "휴원할 반을 다시 선택해 주세요." };
    }
    if (ids.length > MAX_PAUSE_CLASSES_PER_REQUEST) {
      return { ok: false as const, message: `한 번에 ${MAX_PAUSE_CLASSES_PER_REQUEST}개 반까지 선택해 주세요.` };
    }
    if (ids.length > 1) return submitMultiClassPause(parentUserId, enrollmentId, ids, input);
  }

  // 복귀 신청은 출발 상태(PAUSED)가 달라 따로 처리한다. 가드는 아래와 같은 세 가지다.
  if (input.kind === RESUME_KIND) return submitResumeRequest(parentUserId, enrollmentId, input);

  // 가드1: 이 수강 등록이 그 부모의 자녀 것이고 지금 다니는(ACTIVE) 반인지 재검증.
  const owned = await prisma.$queryRawUnsafe<any[]>(
    `SELECT e.id, e."classId", s.id AS "studentId", s.name AS "studentName", c.name AS "className",
            c."dayOfWeek" AS "classDayOfWeek", c."startTime" AS "classStartTime"
       FROM "Enrollment" e
       JOIN "Student" s ON s.id = e."studentId"
       JOIN "Class" c ON c.id = e."classId"
      WHERE e.id = $1 AND ${await childAccessSql("s", "$2")} AND e.status = 'ACTIVE' AND ${notMergedStudent("s")}
      LIMIT 1`,
    enrollmentId, parentUserId,
  );
  if (!owned[0]) return { ok: false as const, message: "본인 자녀의 수강만 변경 신청할 수 있습니다." };

  // 가드2: 적용일은 서버가 정한다. 학부모가 고른 날짜도 규칙(반 변경 = 내일 이후 · 휴원 = 오늘 수업 전이면 오늘,
  // 아니면 내일 이후 · 둘 다 3개월 이내)을 통과해야 하고, 벗어나면 조용히 바꾸지 않고 거절한다.
  if (!isChangeKind(input.kind)) {
    return { ok: false as const, message: CHANGE_REQUEST_MESSAGE.INVALID_KIND };
  }
  const today = todayKst();
  const resolved = resolveEffectiveFrom({
    kind: input.kind,
    requestedFrom: input.effectiveFrom,
    today,
    // 그 반 요일·시작 시각은 DB 값으로만 판정한다(화면이 보낸 최소값을 믿지 않는다)
    earliestPauseFrom: earliestPauseStart({
      today, nowHm: kstHm(Date.now()),
      classDayOfWeek: owned[0].classDayOfWeek, classStartTime: owned[0].classStartTime,
    }),
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

type PauseEnrollment = {
  id: string;
  studentId: string;
  studentName: string;
  classId: string;
  className: string;
  classDayOfWeek: string | null;
  classStartTime: string | null;
};

/** 한 번에 선택한 모든 반을 함께 저장한다. 한 반이라도 조건이 맞지 않으면 접수하지 않는다. */
async function submitMultiClassPause(parentUserId: string, enrollmentId: string, ids: string[], input: SubmitChangeInput) {
  const access = await childAccessSql("s", "$2");
  const submissionGroupId = crypto.randomUUID();
  try {
    const result = await prisma.$transaction(async (tx) => {
      const [schema] = await tx.$queryRawUnsafe<{ ready: boolean }[]>(`SELECT ${PAUSE_GROUP_AVAILABLE_SQL} AS ready`);
      if (!schema?.ready) return { ok: false as const, message: "여러 반 휴원 신청을 아직 사용할 수 없습니다." };

      const enrollments = await tx.$queryRawUnsafe<PauseEnrollment[]>(
        `SELECT e.id, s.id AS "studentId", s.name AS "studentName",
                c.id AS "classId", c.name AS "className",
                c."dayOfWeek" AS "classDayOfWeek", c."startTime" AS "classStartTime"
           FROM "Enrollment" e JOIN "Student" s ON s.id = e."studentId"
           JOIN "Class" c ON c.id = e."classId"
          WHERE e.id = ANY($1::text[]) AND e.status = 'ACTIVE'
            AND ${access} AND ${notMergedStudent("s")} AND ${REGULAR_CLASS_FILTER}
          ORDER BY e.id FOR UPDATE OF e`,
        ids, parentUserId,
      );
      const anchor = enrollments.find((row) => row.id === enrollmentId);
      if (!anchor || enrollments.length !== ids.length || enrollments.some((row) => row.studentId !== anchor.studentId)
        || new Set(enrollments.map((row) => row.classId)).size !== ids.length) {
        return { ok: false as const, message: "같은 자녀가 다니는 반만 함께 휴원 신청할 수 있습니다." };
      }

      const today = todayKst();
      const nowHm = kstHm(Date.now());
      const earliest = enrollments.map((row) => earliestPauseStart({ today, nowHm, ...row })).sort().at(-1);
      const resolved = resolveEffectiveFrom({ kind: "PAUSE", requestedFrom: input.effectiveFrom, today, earliestPauseFrom: earliest });
      if (!resolved.ok) return { ok: false as const, message: CHANGE_REQUEST_MESSAGE[resolved.error] };
      const effectiveFrom = resolved.effectiveFrom;
      const checked = validateChangeRequest(input, { currentClassId: anchor.classId, effectiveFrom });
      if (!checked.ok) return { ok: false as const, message: CHANGE_REQUEST_MESSAGE[checked.error] };

      const existing = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM "EnrollmentChangeRequest" WHERE "enrollmentId" = ANY($1::text[])
          AND (status = 'PENDING' OR (status = 'APPROVED' AND "appliedAt" IS NULL AND "effectiveFrom" > $2::date))
          LIMIT 1`,
        ids, today,
      );
      if (existing.length) return { ok: false as const, message: "선택한 반에 이미 진행 중인 신청이 있습니다." };

      const resumeOn = input.resumeOn ? String(input.resumeOn) : null;
      const reason = typeof input.reason === "string" ? input.reason.trim() || null : null;
      const created = await tx.$queryRawUnsafe<{ id: string; enrollmentId: string }[]>(
        `INSERT INTO "EnrollmentChangeRequest"
          ("studentId","enrollmentId","fromClassId","kind","effectiveFrom","resumeOn","reason","requestedByUserId","submissionGroupId")
          SELECT e."studentId", e.id, e."classId", 'PAUSE', $2::date, $3::date, $4, $5, $6::uuid
            FROM "Enrollment" e WHERE e.id = ANY($1::text[]) ORDER BY e.id
          RETURNING id, "enrollmentId"`,
        ids, effectiveFrom, resumeOn, reason, parentUserId, submissionGroupId,
      );
      const id = created.find((row) => row.enrollmentId === enrollmentId)?.id;
      if (!id || created.length !== ids.length) throw new Error("PAUSE_SUBMISSION_INCOMPLETE");
      return { ok: true as const, id, effectiveFrom, resumeOn, anchor, enrollments };
    });
    if (!result.ok) return result;
    await notifyAdminsOfChangeRequest({
      studentName: result.anchor.studentName,
      fromClassName: result.enrollments.map((row) => row.className).join(" · "),
      fromClassId: result.anchor.classId,
      classIds: result.enrollments.map((row) => row.classId),
      kind: "PAUSE", effectiveFrom: result.effectiveFrom, toClassName: null, waitlisted: false,
    });
    return {
      ok: true as const, id: result.id, kind: "PAUSE", effectiveFrom: result.effectiveFrom,
      resumeOn: result.resumeOn, toClassName: null, waitlisted: false, submissionGroupId,
    };
  } catch (error) {
    const conflict = error as { code?: string; meta?: { code?: string } };
    if (conflict?.code === "P2002" || conflict?.meta?.code === "23505") {
      return { ok: false as const, message: "선택한 반에 이미 진행 중인 신청이 있습니다." };
    }
    throw error;
  }
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
 * 승인된 휴원·퇴원 «취소 요청»(2026-11-10 원장 결정 d8).
 * 원장이 승인했지만 아직 적용 전(적용일 > KST 오늘)인 휴원·퇴원에 학부모가 «취소해 주세요»를 보낸다.
 * 학부모가 직접 되돌리지는 않는다 — 원장이 /admin/enrollment-changes 에서 승인해야 CANCELED 가 된다.
 *
 * ★ 가드(한 문장 UPDATE 의 WHERE 로 전부 건다 — 확인과 쓰기 사이 틈이 없다):
 *   그 부모의 자녀(childAccessSql)·병합 안 된 학생 · APPROVED · 미적용 · PAUSE/WITHDRAW · 적용일 > KST 오늘 ·
 *   아직 취소 요청 없음(거절된 요청은 다시 못 낸다 — 학원과 직접 이야기).
 */
export async function requestScheduledChangeCancel(parentUserId: string, requestId: string, reason?: unknown) {
  const id = typeof requestId === "string" ? requestId.trim() : "";
  if (!id) return { ok: false as const, message: "취소 요청할 신청을 찾을 수 없습니다." };
  const note = typeof reason === "string" ? reason.trim().slice(0, 300) || null : null;
  const rows = await prisma.$queryRawUnsafe<Array<{ studentName: string; className: string | null; classId: string | null; kind: string; effectiveFrom: string }>>(
    `UPDATE "EnrollmentChangeRequest" r
        SET "cancelRequestStatus" = 'PENDING', "cancelRequestedAt" = now(),
            "cancelRequestedByUserId" = $1, "cancelRequestReason" = $3, "updatedAt" = now()
       FROM "Student" s
      WHERE r."studentId" = s.id
        AND ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
        AND r.id = $2
        AND r.status = 'APPROVED' AND r."appliedAt" IS NULL
        AND r.kind IN ('PAUSE','WITHDRAW')
        AND r."effectiveFrom" > (now() AT TIME ZONE 'Asia/Seoul')::date
        AND r."cancelRequestStatus" IS NULL
      RETURNING s.name AS "studentName", r."fromClassId" AS "classId",
                (SELECT c.name FROM "Class" c WHERE c.id = r."fromClassId") AS "className",
                r.kind, to_char(r."effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom"`,
    parentUserId, id, note,
  );
  if (!rows[0]) {
    return { ok: false as const, message: "취소 요청을 보낼 수 없는 신청입니다. 이미 적용됐거나 요청을 보냈을 수 있어요." };
  }
  // 원장 알림 — 신청 알림과 같은 경로(실패해도 요청은 남는다)
  try {
    const { notifyOperationalStaff } = await import("@/lib/operational-staff-notification");
    await notifyOperationalStaff({
      type: "ENROLLMENT_CHANGE",
      title: "수강 변경 취소 요청",
      message: `${rows[0].studentName} 학생 ${REQUEST_KIND_LABEL[rows[0].kind] ?? "수강 변경"} 승인 건(${rows[0].className ?? "반"}, ${rows[0].effectiveFrom}부터) 취소 요청 · 적용일 전에 승인·거절해 주세요.`,
      linkUrl: "/admin/enrollment-changes",
      staffLinkUrl: "/staff",
      classId: rows[0].classId ?? undefined,
      includeCoach: false,
    });
  } catch (error) {
    console.error("[parent-change-request] 취소 요청 원장 알림 실패:", error instanceof Error ? error.name : "");
  }
  // 방금 보낸 요청의 상태 한 줄 — 화면이 새로고침을 기다리지 않고 같은 문구를 바로 보여 준다.
  return { ok: true as const, cancelLine: scheduledCancelLine({ status: "PENDING", requestedOn: todayKst(), decisionNote: null }) };
}

/**
 * 신청이 들어온 것을 원장에게 알린다.
 * 알림 실패가 신청을 되돌리면 안 된다 — 학부모는 이미 신청을 마쳤다.
 */
async function notifyAdminsOfChangeRequest(input: {
  studentName: string;
  fromClassName: string;
  fromClassId: string;
  classIds?: string[];
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
      linkUrl: "/admin/inbox?tab=CHANGE&sub=ENROLLMENT",
      staffLinkUrl: "/staff",
      classId: input.fromClassId,
      classIds: input.classIds,
      includeCoach: true,
    });
  } catch (error) {
    console.error("[parent-change-request] 원장 알림 실패:", error);
  }
}
