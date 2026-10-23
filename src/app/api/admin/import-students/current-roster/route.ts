import { userFacingError } from "@/lib/user-facing-error";
import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";

export const dynamic = "force-dynamic";

type BatchRow = {
  id: string;
  status: string;
  spreadsheetTitle: string | null;
  sourceUrl: string | null;
  totalRows: number;
  registrationRows: number;
  errorRows: number;
  createdAt: Date;
  completedAt: Date | null;
};

type SummaryRow = {
  targetMonthNumber: number | null;
  targetRows: number;
  uniqueStudentKeys: number;
  linkedRows: number;
  linkedStudents: number;
  unresolvedRows: number;
  activeRows: number;
  pausedRows: number;
  withdrawnRows: number;
  rowsWithSlots: number;
  selectedSlotPairs: number;
  missingClassSlots: number;
  studentsWithHistory: number;
  previousLedgerRows: number;
  duplicateStudentGroups: number;
  nameConflictGroups: number;
};

type MonthDistributionRow = {
  monthNumber: number | null;
  label: string;
  rowCount: number;
  linkedRows: number;
  activeRows: number;
};

type UnresolvedRow = {
  id: string;
  rowNumber: number;
  studentName: string;
  parentName: string | null;
  parentPhone: string | null;
  studentPhone: string | null;
  birthDate: Date | null;
  school: string | null;
  grade: string | null;
  registrationMonth: string | null;
  status: string;
};

type DuplicateGroupRow = {
  studentName: string;
  parentPhone: string | null;
  studentCount: number;
  studentIds: string[];
  parentNames: string[];
};

type NameConflictRow = {
  studentName: string;
  studentCount: number;
  studentIds: string[];
};

type HistorySampleRow = {
  studentId: string;
  studentName: string;
  parentPhone: string | null;
  previousRows: number;
  previousMonths: string[];
};

type MissingSlotRow = {
  slotKey: string;
  rowCount: number;
};

type StatusBreakdownRow = {
  status: string;
  rowCount: number;
  studentCount: number;
};

type StatusSampleRow = {
  status: string;
  studentId: string | null;
  studentName: string;
  parentName: string | null;
  parentPhone: string | null;
  studentPhone: string | null;
  school: string | null;
  grade: string | null;
  registrationMonth: string | null;
  firstRowNumber: number;
  rowCount: number;
  slotKeys: string[] | null;
};

function parseMonth(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) return null;
  return parsed;
}

const LEDGER_CTE = `
  WITH ledger AS (
    SELECT
      r.*,
      (
        string_to_array(
          trim(both ',' from regexp_replace(COALESCE(r."registrationMonth", ''), '[^0-9]+', ',', 'g')),
          ','
        )
      )[2]::int AS "monthNumber"
    FROM "StudentRegistrationLedger" r
    WHERE r."batchId" = $1
  ),
  selected_month AS (
    SELECT COALESCE(
      $2::int,
      (
        SELECT l."monthNumber"
        FROM ledger l
        WHERE l."monthNumber" IS NOT NULL
        GROUP BY l."monthNumber"
        ORDER BY l."monthNumber" DESC
        LIMIT 1
      )
    ) AS "monthNumber"
  ),
  target AS (
    SELECT l.*
    FROM ledger l
    CROSS JOIN selected_month sm
    WHERE sm."monthNumber" IS NULL
       OR l."monthNumber" = sm."monthNumber"
  )
`;

async function getLatestCompletedBatch() {
  const rows = await prisma.$queryRawUnsafe<BatchRow[]>(
    `SELECT id, status, "spreadsheetTitle", "sourceUrl", "totalRows",
            "registrationRows", "errorRows", "createdAt", "completedAt"
     FROM "StudentSheetImportBatch"
     WHERE status = 'COMPLETED'
     ORDER BY "createdAt" DESC
     LIMIT 1`
  );

  return rows[0] ?? null;
}

async function getSummary(batchId: string, requestedMonth: number | null) {
  const rows = await prisma.$queryRawUnsafe<SummaryRow[]>(
    `${LEDGER_CTE},
    target_slots AS (
      SELECT slot_key AS "slotKey", t.id AS "ledgerId"
      FROM target t
      CROSS JOIN LATERAL jsonb_array_elements_text(
        COALESCE(NULLIF(t."selectedSlotKeysJSON", ''), '[]')::jsonb
      ) AS slot_key
    ),
    missing_class_slots AS (
      SELECT ts."slotKey", COUNT(DISTINCT ts."ledgerId")::int AS "rowCount"
      FROM target_slots ts
      LEFT JOIN "Class" c ON c."slotKey" = ts."slotKey"
      WHERE c.id IS NULL
      GROUP BY ts."slotKey"
    ),
    history AS (
      SELECT p.*
      FROM "StudentRegistrationLedger" p
      JOIN target t ON t."studentId" IS NOT NULL
                  AND p."studentId" = t."studentId"
                  AND p.id <> t.id
    ),
    target_identity_keys AS (
      SELECT DISTINCT
        lower(trim(t."studentName")) AS "normalizedName",
        regexp_replace(COALESCE(t."parentPhone", ''), '[^0-9]', '', 'g') AS "parentPhone"
      FROM target t
      WHERE t."studentName" IS NOT NULL
        AND regexp_replace(COALESCE(t."parentPhone", ''), '[^0-9]', '', 'g') <> ''
    ),
    duplicate_student_groups AS (
      SELECT
        lower(trim(s.name)) AS "normalizedName",
        regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') AS "parentPhone",
        COUNT(DISTINCT s.id)::int AS "studentCount"
      FROM "Student" s
      LEFT JOIN "User" u ON u.id = s."parentId"
      JOIN target_identity_keys tik
        ON tik."normalizedName" = lower(trim(s.name))
       AND tik."parentPhone" = regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g')
      -- 이미 병합한 쌍이 "중복 그룹"으로 계속 뜨지 않도록 흡수된 쪽은 세지 않는다.
      WHERE ${notMergedStudent("s")}
      GROUP BY lower(trim(s.name)), regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g')
      HAVING COUNT(DISTINCT s.id) > 1
    ),
    unresolved_names AS (
      SELECT DISTINCT lower(trim(t."studentName")) AS "normalizedName", t."studentName"
      FROM target t
      WHERE t."studentId" IS NULL
        AND t."studentName" IS NOT NULL
    ),
    name_conflict_groups AS (
      SELECT un."normalizedName", COUNT(DISTINCT s.id)::int AS "studentCount"
      FROM unresolved_names un
      JOIN "Student" s ON lower(trim(s.name)) = un."normalizedName"
       AND ${notMergedStudent("s")}
      GROUP BY un."normalizedName"
      HAVING COUNT(DISTINCT s.id) > 1
    )
    SELECT
      (SELECT "monthNumber" FROM selected_month) AS "targetMonthNumber",
      (SELECT COUNT(*)::int FROM target) AS "targetRows",
      (SELECT COUNT(DISTINCT "studentKey")::int FROM target WHERE "studentKey" IS NOT NULL) AS "uniqueStudentKeys",
      (SELECT COUNT(*)::int FROM target WHERE "studentId" IS NOT NULL) AS "linkedRows",
      (SELECT COUNT(DISTINCT "studentId")::int FROM target WHERE "studentId" IS NOT NULL) AS "linkedStudents",
      (SELECT COUNT(*)::int FROM target WHERE "studentId" IS NULL) AS "unresolvedRows",
      (SELECT COUNT(*)::int FROM target WHERE status = 'ACTIVE') AS "activeRows",
      (SELECT COUNT(*)::int FROM target WHERE status = 'PAUSED') AS "pausedRows",
      (SELECT COUNT(*)::int FROM target WHERE status = 'WITHDRAWN') AS "withdrawnRows",
      (SELECT COUNT(DISTINCT "ledgerId")::int FROM target_slots) AS "rowsWithSlots",
      (SELECT COUNT(*)::int FROM target_slots) AS "selectedSlotPairs",
      (SELECT COUNT(*)::int FROM missing_class_slots) AS "missingClassSlots",
      (SELECT COUNT(DISTINCT "studentId")::int FROM history WHERE "studentId" IS NOT NULL) AS "studentsWithHistory",
      (SELECT COUNT(*)::int FROM history) AS "previousLedgerRows",
      (SELECT COUNT(*)::int FROM duplicate_student_groups) AS "duplicateStudentGroups",
      (SELECT COUNT(*)::int FROM name_conflict_groups) AS "nameConflictGroups"`,
    batchId,
    requestedMonth
  );

  return rows[0] ?? null;
}

async function getMonthDistribution(batchId: string) {
  return prisma.$queryRawUnsafe<MonthDistributionRow[]>(
    `WITH ledger AS (
      SELECT
        r.*,
        (
          string_to_array(
            trim(both ',' from regexp_replace(COALESCE(r."registrationMonth", ''), '[^0-9]+', ',', 'g')),
            ','
          )
        )[2]::int AS "monthNumber"
      FROM "StudentRegistrationLedger" r
      WHERE r."batchId" = $1
    )
    SELECT
      "monthNumber",
      COALESCE(NULLIF("registrationMonth", ''), '월 미입력') AS label,
      COUNT(*)::int AS "rowCount",
      COUNT(*) FILTER (WHERE "studentId" IS NOT NULL)::int AS "linkedRows",
      COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS "activeRows"
    FROM ledger
    GROUP BY "monthNumber", COALESCE(NULLIF("registrationMonth", ''), '월 미입력')
    ORDER BY "monthNumber" DESC NULLS LAST, label`,
    batchId
  );
}

async function getUnresolvedRows(batchId: string, requestedMonth: number | null) {
  return prisma.$queryRawUnsafe<UnresolvedRow[]>(
    `${LEDGER_CTE}
    SELECT id, "rowNumber", "studentName", "parentName", "parentPhone",
           "studentPhone", "birthDate", school, grade, "registrationMonth", status
    FROM target
    WHERE "studentId" IS NULL
    ORDER BY "rowNumber" ASC
    LIMIT 12`,
    batchId,
    requestedMonth
  );
}

async function getDuplicateGroups(batchId: string, requestedMonth: number | null) {
  return prisma.$queryRawUnsafe<DuplicateGroupRow[]>(
    `${LEDGER_CTE},
    target_identity_keys AS (
      SELECT DISTINCT
        lower(trim(t."studentName")) AS "normalizedName",
        regexp_replace(COALESCE(t."parentPhone", ''), '[^0-9]', '', 'g') AS "parentPhone"
      FROM target t
      WHERE t."studentName" IS NOT NULL
        AND regexp_replace(COALESCE(t."parentPhone", ''), '[^0-9]', '', 'g') <> ''
    )
    SELECT
      MAX(s.name) AS "studentName",
      regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') AS "parentPhone",
      COUNT(DISTINCT s.id)::int AS "studentCount",
      array_agg(DISTINCT s.id ORDER BY s.id) AS "studentIds",
      array_remove(array_agg(DISTINCT u.name ORDER BY u.name), NULL) AS "parentNames"
    FROM "Student" s
    LEFT JOIN "User" u ON u.id = s."parentId"
    JOIN target_identity_keys tik
      ON tik."normalizedName" = lower(trim(s.name))
     AND tik."parentPhone" = regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g')
    WHERE ${notMergedStudent("s")}
    GROUP BY lower(trim(s.name)), regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g')
    HAVING COUNT(DISTINCT s.id) > 1
    ORDER BY "studentCount" DESC, "studentName"
    LIMIT 12`,
    batchId,
    requestedMonth
  );
}

async function getNameConflicts(batchId: string, requestedMonth: number | null) {
  return prisma.$queryRawUnsafe<NameConflictRow[]>(
    `${LEDGER_CTE},
    unresolved_names AS (
      SELECT DISTINCT lower(trim(t."studentName")) AS "normalizedName", t."studentName"
      FROM target t
      WHERE t."studentId" IS NULL
        AND t."studentName" IS NOT NULL
    )
    SELECT
      MAX(un."studentName") AS "studentName",
      COUNT(DISTINCT s.id)::int AS "studentCount",
      array_agg(DISTINCT s.id ORDER BY s.id) AS "studentIds"
    FROM unresolved_names un
    JOIN "Student" s ON lower(trim(s.name)) = un."normalizedName"
     AND ${notMergedStudent("s")}
    GROUP BY un."normalizedName"
    HAVING COUNT(DISTINCT s.id) > 1
    ORDER BY "studentCount" DESC, "studentName"
    LIMIT 12`,
    batchId,
    requestedMonth
  );
}

async function getHistorySamples(batchId: string, requestedMonth: number | null) {
  return prisma.$queryRawUnsafe<HistorySampleRow[]>(
    `${LEDGER_CTE}
    SELECT
      t."studentId",
      MAX(t."studentName") AS "studentName",
      MAX(t."parentPhone") AS "parentPhone",
      COUNT(p.id)::int AS "previousRows",
      array_remove(array_agg(DISTINCT p."registrationMonth" ORDER BY p."registrationMonth"), NULL) AS "previousMonths"
    FROM target t
    JOIN "StudentRegistrationLedger" p
      ON t."studentId" IS NOT NULL
     AND p."studentId" = t."studentId"
     AND p.id <> t.id
    GROUP BY t."studentId"
    ORDER BY "previousRows" DESC, "studentName"
    LIMIT 12`,
    batchId,
    requestedMonth
  );
}

async function getMissingClassSlots(batchId: string, requestedMonth: number | null) {
  return prisma.$queryRawUnsafe<MissingSlotRow[]>(
    `${LEDGER_CTE},
    target_slots AS (
      SELECT slot_key AS "slotKey", t.id AS "ledgerId"
      FROM target t
      CROSS JOIN LATERAL jsonb_array_elements_text(
        COALESCE(NULLIF(t."selectedSlotKeysJSON", ''), '[]')::jsonb
      ) AS slot_key
      WHERE t.status = 'ACTIVE'
    )
    SELECT ts."slotKey", COUNT(DISTINCT ts."ledgerId")::int AS "rowCount"
    FROM target_slots ts
    LEFT JOIN "Class" c ON c."slotKey" = ts."slotKey"
    WHERE c.id IS NULL
    GROUP BY ts."slotKey"
    ORDER BY "rowCount" DESC, ts."slotKey"
    LIMIT 12`,
    batchId,
    requestedMonth
  );
}

async function getStatusBreakdown(batchId: string, requestedMonth: number | null) {
  return prisma.$queryRawUnsafe<StatusBreakdownRow[]>(
    `${LEDGER_CTE},
    target_with_key AS (
      SELECT
        t.*,
        COALESCE(
          t."studentId",
          t."studentKey",
          lower(trim(t."studentName")) || ':' || regexp_replace(COALESCE(t."parentPhone", ''), '[^0-9]', '', 'g'),
          t.id
        ) AS "rosterKey"
      FROM target t
    ),
    student_status AS (
      SELECT
        twk."rosterKey",
        COUNT(*)::int AS "rowCount",
        CASE
          WHEN BOOL_OR(twk.status = 'WITHDRAWN') THEN 'WITHDRAWN'
          WHEN BOOL_OR(twk.status = 'ACTIVE') THEN 'ACTIVE'
          WHEN BOOL_OR(twk.status = 'PAUSED') THEN 'PAUSED'
          ELSE 'UNKNOWN'
        END AS status
      FROM target_with_key twk
      GROUP BY twk."rosterKey"
    )
    SELECT
      status,
      SUM("rowCount")::int AS "rowCount",
      COUNT(*)::int AS "studentCount"
    FROM student_status
    GROUP BY status
    ORDER BY CASE status
      WHEN 'ACTIVE' THEN 1
      WHEN 'PAUSED' THEN 2
      WHEN 'WITHDRAWN' THEN 3
      ELSE 4
    END`,
    batchId,
    requestedMonth
  );
}

async function getStatusSamples(batchId: string, requestedMonth: number | null) {
  return prisma.$queryRawUnsafe<StatusSampleRow[]>(
    `${LEDGER_CTE},
    target_with_key AS (
      SELECT
        t.*,
        COALESCE(
          t."studentId",
          t."studentKey",
          lower(trim(t."studentName")) || ':' || regexp_replace(COALESCE(t."parentPhone", ''), '[^0-9]', '', 'g'),
          t.id
        ) AS "rosterKey"
      FROM target t
    ),
    target_slots AS (
      SELECT twk."rosterKey", slot_key AS "slotKey"
      FROM target_with_key twk
      LEFT JOIN LATERAL jsonb_array_elements_text(
        COALESCE(NULLIF(twk."selectedSlotKeysJSON", ''), '[]')::jsonb
      ) AS slot_key ON true
    ),
    student_status AS (
      SELECT
        twk."rosterKey",
        MAX(twk."studentId") AS "studentId",
        MAX(twk."studentName") AS "studentName",
        MAX(twk."parentName") AS "parentName",
        MAX(twk."parentPhone") AS "parentPhone",
        MAX(twk."studentPhone") AS "studentPhone",
        MAX(twk.school) AS school,
        MAX(twk.grade) AS grade,
        MAX(twk."registrationMonth") AS "registrationMonth",
        MIN(twk."rowNumber")::int AS "firstRowNumber",
        COUNT(*)::int AS "rowCount",
        CASE
          WHEN BOOL_OR(twk.status = 'WITHDRAWN') THEN 'WITHDRAWN'
          WHEN BOOL_OR(twk.status = 'ACTIVE') THEN 'ACTIVE'
          WHEN BOOL_OR(twk.status = 'PAUSED') THEN 'PAUSED'
          ELSE 'UNKNOWN'
        END AS status
      FROM target_with_key twk
      GROUP BY twk."rosterKey"
    ),
    slot_groups AS (
      SELECT
        ts."rosterKey",
        COALESCE(json_agg(DISTINCT ts."slotKey") FILTER (WHERE ts."slotKey" IS NOT NULL), '[]'::json) AS "slotKeys"
      FROM target_slots ts
      GROUP BY ts."rosterKey"
    ),
    ranked AS (
      SELECT
        ss.*,
        COALESCE(sg."slotKeys", '[]'::json) AS "slotKeys",
        ROW_NUMBER() OVER (
          PARTITION BY ss.status
          ORDER BY ss."firstRowNumber" ASC, ss."studentName" ASC
        ) AS rn
      FROM student_status ss
      LEFT JOIN slot_groups sg ON sg."rosterKey" = ss."rosterKey"
      WHERE ss.status IN ('PAUSED', 'WITHDRAWN')
    )
    SELECT
      status,
      "studentId",
      "studentName",
      "parentName",
      "parentPhone",
      "studentPhone",
      school,
      grade,
      "registrationMonth",
      "firstRowNumber",
      "rowCount",
      "slotKeys"
    FROM ranked
    WHERE rn <= 8
    ORDER BY CASE status WHEN 'PAUSED' THEN 1 WHEN 'WITHDRAWN' THEN 2 ELSE 3 END,
             "firstRowNumber" ASC`,
    batchId,
    requestedMonth
  );
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  }

  try {
    const requestedMonth = parseMonth(request.nextUrl.searchParams.get("month"));
    const batch = await getLatestCompletedBatch();

    if (!batch) {
      return NextResponse.json({
        batch: null,
        targetMonth: {
          requestedMonth,
          monthNumber: requestedMonth,
          label: requestedMonth ? `${requestedMonth}월` : "전체",
        },
        summary: null,
        monthDistribution: [],
        unresolvedRows: [],
        duplicateStudentGroups: [],
        nameConflictGroups: [],
        historySamples: [],
        missingClassSlots: [],
        statusBreakdown: [],
        statusSamples: [],
      });
    }

    const [
      summary,
      monthDistribution,
      unresolvedRows,
      duplicateStudentGroups,
      nameConflictGroups,
      historySamples,
      missingClassSlots,
      statusBreakdown,
      statusSamples,
    ] = await Promise.all([
      getSummary(batch.id, requestedMonth),
      getMonthDistribution(batch.id),
      getUnresolvedRows(batch.id, requestedMonth),
      getDuplicateGroups(batch.id, requestedMonth),
      getNameConflicts(batch.id, requestedMonth),
      getHistorySamples(batch.id, requestedMonth),
      getMissingClassSlots(batch.id, requestedMonth),
      getStatusBreakdown(batch.id, requestedMonth),
      getStatusSamples(batch.id, requestedMonth),
    ]);

    const targetMonthNumber = summary?.targetMonthNumber ?? requestedMonth;

    return NextResponse.json({
      batch,
      targetMonth: {
        requestedMonth,
        monthNumber: targetMonthNumber,
        label: targetMonthNumber ? `${targetMonthNumber}월` : "전체",
      },
      summary,
      monthDistribution,
      unresolvedRows,
      duplicateStudentGroups,
      nameConflictGroups,
      historySamples,
      missingClassSlots,
      statusBreakdown,
      statusSamples,
    });
  } catch (error) {
    console.error("[api/admin/import-students/current-roster] failed:", error);
    return NextResponse.json(
      { error: userFacingError(error, "최신 원생목록 점검에 실패했습니다.") },
      { status: 500 }
    );
  }
}
