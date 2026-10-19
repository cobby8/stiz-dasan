import { userFacingError } from "@/lib/user-facing-error";
import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";

import { requireAdmin } from "@/lib/auth-guard";
import {
  MAX_PAUSE_MONTHS,
  WITHDRAW_CANDIDATE_MIN_GAP_MONTHS,
} from "@/lib/enrollmentReconcilePolicy";
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";

type ReconcileSampleRow = {
  studentId: string;
  studentName: string;
  slotKey: string;
  currentStatus?: string | null;
  targetStatus?: string | null;
  /** 퇴원 후보 전용: 마지막으로 시트에 등장한 달 ("2026년 4월") */
  lastSeenMonth?: string | null;
  /** 퇴원 후보 전용: 이미 지나간 미등장 개월 수 */
  monthsMissing?: number | null;
};

type ReconcilePreview = {
  batchId: string | null;
  expectedActivePairs: number;
  missingEnrollments: number;
  reactivations: number;
  pauseExtras: number;
  unresolvedLedgerRows: number;
  missingClassSlots: number;
  outsideScopeActiveStudents: number;
  /** 약관 휴원 한도를 넘겨 사라진 "퇴원 후보" 수강 등록 건수 (자동 반영되지 않는다) */
  withdrawCandidates: number;
  /** 위 후보에 해당하는 학생 수 (건수와 다르다 — 한 학생이 여러 반일 수 있다) */
  withdrawCandidateStudents: number;
  maxPauseMonths: number;
  samples: {
    missing: ReconcileSampleRow[];
    reactivations: ReconcileSampleRow[];
    pauseExtras: ReconcileSampleRow[];
    withdrawCandidates: ReconcileSampleRow[];
  };
};

const LATEST_BATCH_SQL = `
  SELECT id
  FROM "StudentSheetImportBatch"
  WHERE status = 'COMPLETED'
  ORDER BY "createdAt" DESC
  LIMIT 1
`;

/**
 * "2026년 8월" 같은 등록월 문자열에서 숫자만 뽑아 배열로 만드는 식.
 * (별칭 r 을 쓰는 곳에서만 사용한다)
 */
const MONTH_TOKENS_SQL = `
  string_to_array(
    trim(both ',' from regexp_replace(COALESCE(r."registrationMonth", ''), '[^0-9]+', ',', 'g')),
    ','
  )
`;

/**
 * 연·월을 하나의 정수(연도 × 12 + 월)로 만든다.
 * 왜 필요한가? 기존 `monthNumber`는 "월" 숫자만 뽑아서 2025년 12월이 2026년 8월보다 커진다.
 * 개월 수 차이를 재려면 연도까지 포함한 값이 있어야 한다.
 * 연도가 안 적힌 행(숫자 토큰 1개)은 NULL → 판정 대상에서 자동 제외(안전한 쪽).
 */
const MONTH_INDEX_SQL = `
  CASE
    WHEN array_length(${MONTH_TOKENS_SQL}, 1) >= 2
      THEN (${MONTH_TOKENS_SQL})[1]::int * 12 + (${MONTH_TOKENS_SQL})[2]::int
    ELSE NULL
  END
`;

const RECONCILE_CTE = `
  WITH latest AS (${LATEST_BATCH_SQL}),
  ledger AS (
    SELECT
      r.*,
      (${MONTH_TOKENS_SQL})[2]::int AS "monthNumber",
      ${MONTH_INDEX_SQL} AS "monthIndex"
    FROM "StudentRegistrationLedger" r
    JOIN latest ON latest.id = r."batchId"
  ),
  selected_month AS (
    SELECT l."monthNumber"
    FROM ledger l
    WHERE l."monthNumber" IS NOT NULL
    GROUP BY l."monthNumber"
    ORDER BY l."monthNumber" DESC
    LIMIT 1
  ),
  target AS (
    SELECT l.*
    FROM ledger l
    JOIN selected_month sm ON sm."monthNumber" = l."monthNumber"
  ),
  student_month_status AS (
    SELECT
      r."studentId",
      MAX(r."studentName") AS "studentName",
      r."monthNumber",
      MAX(r."registrationMonth") AS "registrationMonth",
      CASE
        WHEN BOOL_OR(r.status = 'WITHDRAWN') THEN 'WITHDRAWN'
        WHEN BOOL_OR(r.status = 'ACTIVE') THEN 'ACTIVE'
        WHEN BOOL_OR(r.status = 'PAUSED') THEN 'PAUSED'
        ELSE 'WITHDRAWN'
      END AS "targetStatus"
    FROM ledger r
    JOIN selected_month sm ON r."monthNumber" <= sm."monthNumber"
    WHERE r."studentId" IS NOT NULL
      AND r."monthNumber" IS NOT NULL
    GROUP BY r."studentId", r."monthNumber"
  ),
  latest_student_status AS (
    SELECT DISTINCT ON (sms."studentId")
      sms."studentId",
      sms."studentName",
      sms."registrationMonth",
      sms."targetStatus"
    FROM student_month_status sms
    ORDER BY sms."studentId", sms."monthNumber" DESC
  ),
  expected_pairs AS (
    SELECT DISTINCT
      r."studentId",
      r."studentName",
      slot_key AS "slotKey",
      c.id AS "classId"
    FROM target r
    CROSS JOIN LATERAL jsonb_array_elements_text(
      COALESCE(NULLIF(r."selectedSlotKeysJSON", ''), '[]')::jsonb
    ) AS slot_key
    JOIN "Class" c ON c."slotKey" = slot_key
    WHERE r."studentId" IS NOT NULL
      AND r.status = 'ACTIVE'
  ),
  active_enrollments AS (
    SELECT
      e.id,
      e."studentId",
      s.name AS "studentName",
      e."classId",
      c."slotKey",
      e.status
    FROM "Enrollment" e
    JOIN "Class" c ON c.id = e."classId"
    JOIN "Student" s ON s.id = e."studentId" AND ${notMergedStudent("s")}
    WHERE c."slotKey" IS NOT NULL
  ),
  missing AS (
    SELECT ep."studentId", ep."studentName", ep."slotKey", ep."classId"
    FROM expected_pairs ep
    LEFT JOIN "Enrollment" e ON e."studentId" = ep."studentId" AND e."classId" = ep."classId"
    WHERE e.id IS NULL
  ),
  reactivations AS (
    SELECT ep."studentId", ep."studentName", ep."slotKey", ep."classId", e.status AS "currentStatus"
    FROM expected_pairs ep
    JOIN "Enrollment" e ON e."studentId" = ep."studentId" AND e."classId" = ep."classId"
    WHERE e.status <> 'ACTIVE'
  ),
  pause_extras AS (
    SELECT
      ae.id,
      ae."studentId",
      ae."studentName",
      ae."slotKey",
      ae."classId",
      ae.status AS "currentStatus",
      CASE
        WHEN ss."targetStatus" IN ('PAUSED', 'WITHDRAWN') THEN ss."targetStatus"
        -- 시트에서 조용히 사라진 학생은 여기(휴원)로 떨어진다.
        -- 이 자리에서 곧바로 퇴원으로 바꾸지 않는 이유: 반 명단에서 사라지고 청구가 끊기는
        -- 되돌리기 어려운 처리이기 때문. 대신 아래 withdraw_candidates 가 "퇴원 후보"로 따로 뽑아
        -- 관리자가 눈으로 확인하고 별도 버튼으로만 확정하게 한다.
        ELSE 'PAUSED'
      END AS "targetStatus"
    FROM active_enrollments ae
    LEFT JOIN latest_student_status ss ON ss."studentId" = ae."studentId"
    LEFT JOIN expected_pairs ep ON ep."studentId" = ae."studentId" AND ep."classId" = ae."classId"
    WHERE ae.status = 'ACTIVE'
      AND ep."studentId" IS NULL
  ),
  -- ── 여기부터: "시트에서 사라진 지 오래된 학생" 판정용 ──────────────────────────
  -- 위쪽 CTE들은 전부 "가장 최근 배치 1건"만 본다. 그런데 최근 배치에는 다음 달(8월) 한 달치만
  -- 들어 있는 경우가 많아, 그 배치만으로는 "이 학생이 마지막으로 언제 등장했는지"를 알 수 없다.
  -- 그래서 마지막 등장월은 완료된 배치 전체의 원장을 훑어서 구한다.
  sheet_rows AS (
    SELECT
      r."studentId",
      r."studentName",
      r.status,
      r."registrationMonth",
      ${MONTH_INDEX_SQL} AS "monthIndex"
    FROM "StudentRegistrationLedger" r
    JOIN "StudentSheetImportBatch" b ON b.id = r."batchId" AND b.status = 'COMPLETED'
    WHERE r."studentId" IS NOT NULL
  ),
  sheet_month_status AS (
    SELECT
      "studentId",
      MAX("studentName") AS "studentName",
      "monthIndex",
      MAX("registrationMonth") AS "registrationMonth",
      CASE
        WHEN BOOL_OR(status = 'WITHDRAWN') THEN 'WITHDRAWN'
        WHEN BOOL_OR(status = 'ACTIVE') THEN 'ACTIVE'
        WHEN BOOL_OR(status = 'PAUSED') THEN 'PAUSED'
        ELSE 'WITHDRAWN'
      END AS "monthStatus"
    FROM sheet_rows
    WHERE "monthIndex" IS NOT NULL
    GROUP BY "studentId", "monthIndex"
  ),
  student_last_seen AS (
    SELECT DISTINCT ON (sms."studentId")
      sms."studentId",
      sms."studentName",
      sms."monthIndex",
      sms."registrationMonth",
      sms."monthStatus"
    FROM sheet_month_status sms
    ORDER BY sms."studentId", sms."monthIndex" DESC
  ),
  -- 기준월 = 이번에 올린 시트의 등록월(예: 2026년 8월). 아직 시작하지 않은 달이다.
  reference_month AS (
    SELECT MAX(l."monthIndex") AS "monthIndex"
    FROM ledger l
  ),
  withdraw_candidates AS (
    SELECT
      ae.id,
      ae."studentId",
      ae."studentName",
      ae."slotKey",
      ae."classId",
      ae.status AS "currentStatus",
      'WITHDRAWN'::text AS "targetStatus",
      ls."registrationMonth" AS "lastSeenMonth",
      ls."monthStatus" AS "lastSheetStatus",
      (rm."monthIndex" - ls."monthIndex" - 1)::int AS "monthsMissing"
    FROM active_enrollments ae
    -- INNER JOIN 이 곧 "신규 등록자 보호 장치"다. 시트 이력이 한 줄도 없는 학생
    -- (수기 등록·이번 달 첫 등록)은 여기서 아예 걸러진다.
    JOIN student_last_seen ls ON ls."studentId" = ae."studentId"
    CROSS JOIN reference_month rm
    LEFT JOIN expected_pairs ep ON ep."studentId" = ae."studentId" AND ep."classId" = ae."classId"
    WHERE ae.status IN ('ACTIVE', 'PAUSED')
      -- 이번 시트에 다시 나타났으면 복귀 대상이지 퇴원 대상이 아니다.
      AND ep."studentId" IS NULL
      AND rm."monthIndex" IS NOT NULL
      AND ls."monthIndex" IS NOT NULL
      -- 약관상 휴원 한도(${MAX_PAUSE_MONTHS}개월)를 이미 지나쳐 버린 경우만.
      -- 기준월은 아직 안 지난 달이라 결석 개월 수에서 한 칸 빼고 센다.
      AND rm."monthIndex" - ls."monthIndex" >= ${WITHDRAW_CANDIDATE_MIN_GAP_MONTHS}
  ),
  missing_class_slots AS (
    SELECT DISTINCT slot_key AS "slotKey"
    FROM target r
    CROSS JOIN LATERAL jsonb_array_elements_text(
      COALESCE(NULLIF(r."selectedSlotKeysJSON", ''), '[]')::jsonb
    ) AS slot_key
    LEFT JOIN "Class" c ON c."slotKey" = slot_key
    WHERE r."studentId" IS NOT NULL
      AND r.status = 'ACTIVE'
      AND c.id IS NULL
  ),
  outside_scope AS (
    SELECT DISTINCT ae."studentId"
    FROM active_enrollments ae
    LEFT JOIN latest_student_status ss ON ss."studentId" = ae."studentId"
    WHERE ae.status = 'ACTIVE'
      AND ss."studentId" IS NULL
  )
`;

async function getPreview(): Promise<ReconcilePreview> {
  const latestRows = await prisma.$queryRawUnsafe<{ id: string }[]>(LATEST_BATCH_SQL);
  const batchId = latestRows[0]?.id ?? null;

  if (!batchId) {
    return {
      batchId: null,
      expectedActivePairs: 0,
      missingEnrollments: 0,
      reactivations: 0,
      pauseExtras: 0,
      unresolvedLedgerRows: 0,
      missingClassSlots: 0,
      outsideScopeActiveStudents: 0,
      withdrawCandidates: 0,
      withdrawCandidateStudents: 0,
      maxPauseMonths: MAX_PAUSE_MONTHS,
      samples: { missing: [], reactivations: [], pauseExtras: [], withdrawCandidates: [] },
    };
  }

  const [summaryRows, missing, reactivations, pauseExtras, withdrawCandidates] = await Promise.all([
    prisma.$queryRawUnsafe<{
      expectedActivePairs: number;
      missingEnrollments: number;
      reactivations: number;
      pauseExtras: number;
      unresolvedLedgerRows: number;
      missingClassSlots: number;
      outsideScopeActiveStudents: number;
      withdrawCandidates: number;
      withdrawCandidateStudents: number;
    }[]>(`
      ${RECONCILE_CTE}
      SELECT
        (SELECT COUNT(*)::int FROM expected_pairs) AS "expectedActivePairs",
        (SELECT COUNT(*)::int FROM missing) AS "missingEnrollments",
        (SELECT COUNT(*)::int FROM reactivations) AS reactivations,
        (SELECT COUNT(*)::int FROM pause_extras) AS "pauseExtras",
        (SELECT COUNT(*)::int FROM target WHERE "studentId" IS NULL) AS "unresolvedLedgerRows",
        (SELECT COUNT(*)::int FROM missing_class_slots) AS "missingClassSlots",
        (SELECT COUNT(*)::int FROM outside_scope) AS "outsideScopeActiveStudents",
        (SELECT COUNT(*)::int FROM withdraw_candidates) AS "withdrawCandidates",
        (SELECT COUNT(DISTINCT "studentId")::int FROM withdraw_candidates) AS "withdrawCandidateStudents"
    `),
    prisma.$queryRawUnsafe<ReconcileSampleRow[]>(`
      ${RECONCILE_CTE}
      SELECT "studentId", "studentName", "slotKey"
      FROM missing
      ORDER BY "slotKey", "studentName"
      LIMIT 8
    `),
    prisma.$queryRawUnsafe<ReconcileSampleRow[]>(`
      ${RECONCILE_CTE}
      SELECT "studentId", "studentName", "slotKey", "currentStatus"
      FROM reactivations
      ORDER BY "slotKey", "studentName"
      LIMIT 8
    `),
    prisma.$queryRawUnsafe<ReconcileSampleRow[]>(`
      ${RECONCILE_CTE}
      SELECT "studentId", "studentName", "slotKey", "currentStatus", "targetStatus"
      FROM pause_extras
      ORDER BY "slotKey", "studentName"
      LIMIT 8
    `),
    // 퇴원 후보는 관리자가 이름을 하나하나 확인해야 하므로 넉넉히(최대 50건) 내려준다.
    prisma.$queryRawUnsafe<ReconcileSampleRow[]>(`
      ${RECONCILE_CTE}
      SELECT "studentId", "studentName", "slotKey", "currentStatus", "targetStatus", "lastSeenMonth", "monthsMissing"
      FROM withdraw_candidates
      ORDER BY "monthsMissing" DESC, "studentName", "slotKey"
      LIMIT 50
    `),
  ]);

  const summary = summaryRows[0];
  return {
    batchId,
    expectedActivePairs: summary?.expectedActivePairs ?? 0,
    missingEnrollments: summary?.missingEnrollments ?? 0,
    reactivations: summary?.reactivations ?? 0,
    pauseExtras: summary?.pauseExtras ?? 0,
    unresolvedLedgerRows: summary?.unresolvedLedgerRows ?? 0,
    missingClassSlots: summary?.missingClassSlots ?? 0,
    outsideScopeActiveStudents: summary?.outsideScopeActiveStudents ?? 0,
    withdrawCandidates: summary?.withdrawCandidates ?? 0,
    withdrawCandidateStudents: summary?.withdrawCandidateStudents ?? 0,
    maxPauseMonths: MAX_PAUSE_MONTHS,
    samples: { missing, reactivations, pauseExtras, withdrawCandidates },
  };
}

function revalidateReconcileCaches() {
  for (const tag of ["admin-students", "admin-student-imports", "admin-classes", "admin-schedule", "admin-dashboard"]) {
    revalidateTag(tag, { expire: 0 });
  }

  revalidatePath("/admin/students");
  revalidatePath("/admin/classes");
  revalidatePath("/admin/schedule");
}

export async function GET() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  }

  try {
    return NextResponse.json(await getPreview());
  } catch (error) {
    console.error("[api/admin/import-students/reconcile] preview failed:", error);
    return NextResponse.json(
      { error: userFacingError(error, "수강 등록 정합성 점검에 실패했습니다.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  }

  // 퇴원 확정은 "명시적으로 요청했을 때만" 실행한다.
  // 기존 화면은 본문 없이 POST 하므로, 파싱 실패는 곧 "퇴원 안 함"이다(기본값이 안전한 쪽).
  let applyWithdrawals = false;
  try {
    const body = (await request.json()) as { applyWithdrawals?: unknown } | null;
    applyWithdrawals = body?.applyWithdrawals === true;
  } catch {
    applyWithdrawals = false;
  }

  try {
    const before = await getPreview();
    if (!before.batchId) {
      return NextResponse.json({ error: "완료된 수강생 이관 배치가 없습니다." }, { status: 400 });
    }

    const statements = [
      prisma.$executeRawUnsafe(`
        ${RECONCILE_CTE}
        INSERT INTO "Enrollment" (id, "studentId", "classId", status, "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, "studentId", "classId", 'ACTIVE', NOW(), NOW()
        FROM missing
      `),
      prisma.$executeRawUnsafe(`
        ${RECONCILE_CTE}
        UPDATE "Enrollment" e
        SET status = 'ACTIVE', "updatedAt" = NOW()
        FROM reactivations r
        WHERE e."studentId" = r."studentId"
          AND e."classId" = r."classId"
      `),
      prisma.$executeRawUnsafe(`
        ${RECONCILE_CTE}
        UPDATE "Enrollment" e
        SET status = p."targetStatus", "updatedAt" = NOW()
        FROM pause_extras p
        WHERE e.id = p.id
      `),
    ];

    if (applyWithdrawals) {
      // 휴원 처리(위 3번째 문) 다음에 실행돼야 최종 상태가 퇴원으로 남는다.
      statements.push(
        prisma.$executeRawUnsafe(`
          ${RECONCILE_CTE}
          UPDATE "Enrollment" e
          SET status = 'WITHDRAWN', "updatedAt" = NOW()
          FROM withdraw_candidates w
          WHERE e.id = w.id
            AND e.status <> 'WITHDRAWN'
        `),
      );
    }

    const results = await prisma.$transaction(statements);
    const [created, reactivated, paused] = results;
    const withdrawn = applyWithdrawals ? (results[3] ?? 0) : 0;

    revalidateReconcileCaches();
    const after = await getPreview();

    return NextResponse.json({
      success: true,
      batchId: before.batchId,
      applied: {
        created,
        reactivated,
        paused,
        withdrawn,
      },
      before,
      after,
    });
  } catch (error) {
    console.error("[api/admin/import-students/reconcile] apply failed:", error);
    return NextResponse.json(
      { error: userFacingError(error, "수강 등록 정합성 적용에 실패했습니다.") },
      { status: 500 },
    );
  }
}
