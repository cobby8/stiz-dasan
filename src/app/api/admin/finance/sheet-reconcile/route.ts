import { userFacingError } from "@/lib/user-facing-error";
import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type ReconcileAction = "CREATE" | "UPDATE" | "UNCHANGED" | "REVIEW";

type ReconcileSummaryRow = {
  action: ReconcileAction;
  count: number;
  amount: number;
};

type ReconcileSampleRow = {
  studentId: string;
  studentName: string;
  rowCount: number;
  paymentMethods: string[] | null;
  targetStatus: string | null;
  targetAmount: number | null;
  targetMethod: string | null;
  existingStatus: string | null;
  existingAmount: number | null;
  existingMethod: string | null;
  reviewReason: string | null;
  action: ReconcileAction;
};

type BatchRow = {
  id: string;
  createdAt: Date;
  completedAt: Date | null;
  spreadsheetTitle: string | null;
};

const PAID_METHODS_SQL = "'랠리즈', '카드결제', '카드', '현금영수증', '현금'";
const UNPAID_METHODS_SQL = "'미납', '미결제'";

function parseTarget(searchParams: URLSearchParams) {
  const now = new Date();
  const year = Number(searchParams.get("year") ?? now.getFullYear());
  const month = Number(searchParams.get("month") ?? now.getMonth() + 1);

  if (!Number.isInteger(year) || year < 2020 || year > 2035) {
    throw new Error("유효한 연도를 입력해 주세요.");
  }

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("유효한 월을 입력해 주세요.");
  }

  return { year, month };
}

function buildReconcileCte() {
  return `
    WITH latest AS (
      SELECT id, "createdAt", "completedAt", "spreadsheetTitle"
      FROM "StudentSheetImportBatch"
      WHERE status = 'COMPLETED'
      ORDER BY "createdAt" DESC
      LIMIT 1
    ),
    ledger AS (
      SELECT
        r.*,
        NULLIF(substring(COALESCE(r."registrationMonth", '') from '([0-9]{4})[[:space:]]*년'), '')::int AS "targetYear",
        NULLIF(substring(COALESCE(r."registrationMonth", '') from '([0-9]{1,2})[[:space:]]*월'), '')::int AS "targetMonth"
      FROM "StudentRegistrationLedger" r
      JOIN latest ON latest.id = r."batchId"
    ),
    target AS (
      SELECT *
      FROM ledger
      WHERE "targetYear" = $1
        AND "targetMonth" = $2
        AND "studentId" IS NOT NULL
    ),
    grouped AS (
      SELECT
        "studentId",
        MAX("studentName") AS "studentName",
        COUNT(*)::int AS "rowCount",
        array_remove(array_agg(DISTINCT "paymentMethod"), NULL) AS "paymentMethods",
        CASE
          WHEN BOOL_OR(status = 'ACTIVE') THEN 'ACTIVE'
          WHEN BOOL_OR(status = 'PAUSED') THEN 'PAUSED'
          ELSE 'WITHDRAWN'
        END AS "targetEnrollmentStatus",
        SUM(
          CASE
            WHEN "paymentMethod" IN (${PAID_METHODS_SQL})
            THEN COALESCE("paymentAmount", 0)
            ELSE 0
          END
        )::int AS "paidAmount",
        SUM(
          CASE
            WHEN status = 'ACTIVE' AND "paymentMethod" IN (${UNPAID_METHODS_SQL})
            THEN GREATEST(COALESCE("tuitionAmount", 0) + COALESCE("shuttleFee", 0) - COALESCE("carryOverAmount", 0), 0)
            ELSE 0
          END
        )::int AS "pendingAmount",
        BOOL_OR("paymentMethod" = '추가수강') AS "hasReviewOnlyMethod",
        BOOL_OR("paymentMethod" = '이월') AS "hasCarryOverOnlyMethod",
        MAX("paymentDate") AS "paymentDate"
      FROM target
      GROUP BY "studentId"
    ),
    targets AS (
      SELECT
        *,
        CASE
          WHEN "targetEnrollmentStatus" <> 'ACTIVE' THEN 'CANCELED'
          WHEN "paidAmount" > 0 AND "pendingAmount" = 0 THEN 'PAID'
          WHEN "pendingAmount" > 0 AND "paidAmount" = 0 THEN 'PENDING'
          WHEN "paidAmount" = 0 AND "pendingAmount" = 0 AND "hasCarryOverOnlyMethod" THEN 'CANCELED'
          ELSE NULL
        END AS "targetStatus",
        CASE
          WHEN "targetEnrollmentStatus" <> 'ACTIVE' THEN 0
          WHEN "paidAmount" > 0 AND "pendingAmount" = 0 THEN "paidAmount"
          WHEN "pendingAmount" > 0 AND "paidAmount" = 0 THEN "pendingAmount"
          WHEN "paidAmount" = 0 AND "pendingAmount" = 0 AND "hasCarryOverOnlyMethod" THEN 0
          ELSE NULL
        END AS "targetAmount",
        CASE
          WHEN "targetEnrollmentStatus" = 'PAUSED' THEN '휴원'
          WHEN "targetEnrollmentStatus" = 'WITHDRAWN' THEN '퇴원'
          WHEN "paidAmount" > 0 AND "pendingAmount" = 0 THEN
            CASE
              WHEN array_length(array_remove(array_agg_method."paidMethods", NULL), 1) > 1 THEN 'MIXED'
              WHEN '랠리즈' = ANY(array_agg_method."paidMethods") THEN 'RALLYZ'
              WHEN '카드결제' = ANY(array_agg_method."paidMethods") OR '카드' = ANY(array_agg_method."paidMethods") THEN 'CARD'
              WHEN '현금영수증' = ANY(array_agg_method."paidMethods") OR '현금' = ANY(array_agg_method."paidMethods") THEN 'CASH'
              ELSE 'PAID'
            END
          WHEN "pendingAmount" > 0 AND "paidAmount" = 0 THEN 'UNPAID'
          WHEN "paidAmount" = 0 AND "pendingAmount" = 0 AND "hasCarryOverOnlyMethod" THEN 'CARRY_OVER'
          ELSE NULL
        END AS "targetMethod",
        CASE
          WHEN "targetEnrollmentStatus" <> 'ACTIVE' THEN '휴원/퇴원 상태라 자동 청구에서 제외했습니다.'
          WHEN "paidAmount" > 0 AND "pendingAmount" > 0 THEN '납부와 미납 행이 함께 있어 수동 확인이 필요합니다.'
          WHEN "paidAmount" = 0 AND "pendingAmount" = 0 AND "hasReviewOnlyMethod" THEN '추가수강 행만 있어 수동 확인이 필요합니다.'
          WHEN "paidAmount" = 0 AND "pendingAmount" = 0 AND "hasCarryOverOnlyMethod" THEN '이월 행만 있어 청구/미납으로 반영하지 않았습니다.'
          WHEN "paidAmount" = 0 AND "pendingAmount" = 0 THEN '청구 또는 납부 금액이 없습니다.'
          ELSE NULL
        END AS "baseReviewReason"
      FROM grouped
      CROSS JOIN LATERAL (
        SELECT array_remove(array_agg(DISTINCT method), NULL) AS "paidMethods"
        FROM unnest(grouped."paymentMethods") AS method
        WHERE method IN (${PAID_METHODS_SQL})
      ) AS array_agg_method
    ),
    existing AS (
      SELECT
        COUNT(*)::int AS "paymentCount",
        p."studentId",
        SUM(p.amount)::int AS amount,
        CASE WHEN COUNT(DISTINCT p.status) = 1 THEN MAX(p.status) ELSE 'MIXED' END AS status,
        CASE WHEN COUNT(DISTINCT COALESCE(p.method, '')) = 1 THEN MAX(p.method) ELSE 'MIXED' END AS method
      FROM "Payment" p
      WHERE p.year = $1
        AND p.month = $2
        AND p.type = 'MONTHLY'
      GROUP BY p."studentId"
    ),
    actions AS (
      SELECT
        t.*,
        e.amount AS "existingAmount",
        e.status AS "existingStatus",
        e.method AS "existingMethod",
        CASE
          WHEN e."paymentCount" > 1 OR t."rowCount" > 1 THEN '여러 반 또는 여러 납부기록이 있어 반별 대조가 필요합니다.'
          WHEN e."studentId" IS NULL THEN '사이트 납부기록이 없어 원본 증빙과 학생 연결을 확인해야 합니다.'
          WHEN e.amount IS DISTINCT FROM t."targetAmount" OR e.status IS DISTINCT FROM t."targetStatus" THEN '금액 또는 상태가 달라 원본 증빙 확인이 필요합니다.'
          ELSE t."baseReviewReason"
        END AS "reviewReason",
        CASE
          WHEN e."paymentCount" > 1 OR t."rowCount" > 1 THEN 'REVIEW'
          WHEN t."targetStatus" IS NULL THEN 'REVIEW'
          WHEN e."studentId" IS NULL THEN 'REVIEW'
          WHEN t."targetStatus" = 'PENDING'
            AND e.status = 'OVERDUE'
            AND e.amount = t."targetAmount"
            AND COALESCE(e.method, '') = COALESCE(t."targetMethod", '')
          THEN 'UNCHANGED'
          WHEN e.amount <> t."targetAmount"
            OR e.status <> t."targetStatus"
            OR COALESCE(e.method, '') <> COALESCE(t."targetMethod", '')
          THEN 'REVIEW'
          ELSE 'UNCHANGED'
        END AS action
      FROM targets t
      LEFT JOIN existing e ON e."studentId" = t."studentId"
    )
  `;
}

async function getLatestBatch(): Promise<BatchRow | null> {
  const rows = await prisma.$queryRawUnsafe<BatchRow[]>(`
    SELECT id, "createdAt", "completedAt", "spreadsheetTitle"
    FROM "StudentSheetImportBatch"
    WHERE status = 'COMPLETED'
    ORDER BY "createdAt" DESC
    LIMIT 1
  `);

  return rows[0] ?? null;
}

async function getPreview(year: number, month: number) {
  const cte = buildReconcileCte();
  const [batch, summaryRows, samples] = await Promise.all([
    getLatestBatch(),
    prisma.$queryRawUnsafe<ReconcileSummaryRow[]>(
      `
      ${cte}
      SELECT action, COUNT(*)::int AS count, COALESCE(SUM(COALESCE("targetAmount", 0)), 0)::int AS amount
      FROM actions
      GROUP BY action
      ORDER BY action
      `,
      year,
      month,
    ),
    prisma.$queryRawUnsafe<ReconcileSampleRow[]>(
      `
      ${cte}
      SELECT
        "studentId",
        "studentName",
        "rowCount",
        "paymentMethods",
        "targetStatus",
        "targetAmount",
        "targetMethod",
        "existingStatus",
        "existingAmount",
        "existingMethod",
        "reviewReason",
        action
      FROM actions
      WHERE action <> 'UNCHANGED'
      ORDER BY
        CASE action WHEN 'UPDATE' THEN 1 WHEN 'CREATE' THEN 2 ELSE 3 END,
        "studentName"
      LIMIT 20
      `,
      year,
      month,
    ),
  ]);

  if (!batch || summaryRows.length === 0) {
    throw new Error("선택한 월의 저장된 시트 대조 자료가 없습니다. 최신 원본을 확인해 주세요.");
  }

  const summary = {
    create: 0,
    update: 0,
    unchanged: 0,
    review: 0,
    createAmount: 0,
    updateAmount: 0,
    reviewAmount: 0,
  };

  for (const row of summaryRows) {
    const count = Number(row.count ?? 0);
    const amount = Number(row.amount ?? 0);
    if (row.action === "CREATE") {
      summary.create = count;
      summary.createAmount = amount;
    } else if (row.action === "UPDATE") {
      summary.update = count;
      summary.updateAmount = amount;
    } else if (row.action === "UNCHANGED") {
      summary.unchanged = count;
    } else if (row.action === "REVIEW") {
      summary.review = count;
      summary.reviewAmount = amount;
    }
  }

  return {
    batch,
    year,
    month,
    summary,
    samples,
  };
}


export async function GET(request: NextRequest) {
  try {
    await requireAdmin();
    const { year, month } = parseTarget(request.nextUrl.searchParams);
    return NextResponse.json(await getPreview(year, month));
  } catch (error) {
    console.error("[api/admin/finance/sheet-reconcile] preview failed:", error);
    return NextResponse.json(
      { error: userFacingError(error, "시트 기준 수납 점검에 실패했습니다.") },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin();
    parseTarget(request.nextUrl.searchParams);
    // Monthly aggregates cannot safely identify individual class payments.
    return NextResponse.json(
      { error: "반별 납부기록 보호를 위해 시트 자동 적용을 중단했습니다. 확인 필요 항목을 개별 검토해 주세요.", code: "RECONCILE_REVIEW_REQUIRED" },
      { status: 409 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: userFacingError(error, "시트 대조 권한을 확인할 수 없습니다.") },
      { status: 400 },
    );
  }
}
