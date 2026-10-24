import { userFacingError } from "@/lib/user-facing-error";
import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";

type DetailType = "shuttle" | "changes" | "team" | "issues";

const DETAIL_TYPES = new Set<DetailType>(["shuttle", "changes", "team", "issues"]);

function parseDetailType(value: string | null): DetailType {
  if (value && DETAIL_TYPES.has(value as DetailType)) {
    return value as DetailType;
  }
  return "issues";
}

function parseLimit(value: string | null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30;
  return Math.min(Math.floor(parsed), 50);
}

async function resolveBatchId(batchId: string | null) {
  if (batchId) return batchId;

  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id
     FROM "StudentSheetImportBatch"
     ORDER BY CASE WHEN status = 'COMPLETED' THEN 0 ELSE 1 END, "createdAt" DESC
     LIMIT 1`
  );

  return rows[0]?.id ?? null;
}

async function getTotal(tableName: string, batchId: string) {
  const rows = await prisma.$queryRawUnsafe<{ count: number }[]>(
    `SELECT COUNT(*)::int AS count FROM "${tableName}" WHERE "batchId" = $1`,
    batchId
  );
  return rows[0]?.count ?? 0;
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const type = parseDetailType(searchParams.get("type"));
    const limit = parseLimit(searchParams.get("limit"));
    const batchId = await resolveBatchId(searchParams.get("batchId"));

    if (!batchId) {
      return NextResponse.json({ batchId: null, type, total: 0, rows: [] });
    }

    if (type === "shuttle") {
      const [total, rows] = await Promise.all([
        getTotal("StudentShuttleRide", batchId),
        prisma.$queryRawUnsafe(
          `SELECT id, "monthLabel", "rowNumber", "studentName", "studentPhone",
                  "parentPhone", "dayLabel", "classTime", "arrivalTime",
                  destination, note, memo, "studentId", "createdAt"
           FROM "StudentShuttleRide"
           WHERE "batchId" = $1
           ORDER BY "monthLabel" DESC, "rowNumber" ASC
           LIMIT $2`,
          batchId,
          limit
        ),
      ]);
      return NextResponse.json({ batchId, type, total, rows });
    }

    if (type === "changes") {
      const [total, rows] = await Promise.all([
        getTotal("StudentChangeLog", batchId),
        prisma.$queryRawUnsafe(
          `SELECT id, "rowNumber", "occurredAt", "changeSummary",
                  "registrationReflected", "rallyzReflected", "vehicleReflected",
                  "alarmStatus", note, "createdAt"
           FROM "StudentChangeLog"
           WHERE "batchId" = $1
           ORDER BY COALESCE("occurredAt", "createdAt") DESC, "rowNumber" ASC
           LIMIT $2`,
          batchId,
          limit
        ),
      ]);
      return NextResponse.json({ batchId, type, total, rows });
    }

    if (type === "team") {
      const [total, rows] = await Promise.all([
        getTotal("StudentTeamRosterEntry", batchId),
        prisma.$queryRawUnsafe(
          `SELECT id, "rowNumber", "studentName", "birthDate", "jerseyNumber",
                  phone, grade, branch, "studentId", "createdAt"
           FROM "StudentTeamRosterEntry"
           WHERE "batchId" = $1
           ORDER BY "rowNumber" ASC
           LIMIT $2`,
          batchId,
          limit
        ),
      ]);
      return NextResponse.json({ batchId, type, total, rows });
    }

    const [total, rows] = await Promise.all([
      getTotal("StudentSheetImportIssue", batchId),
      prisma.$queryRawUnsafe(
        `SELECT id, "sheetName", "rowNumber", severity, message, "createdAt"
         FROM "StudentSheetImportIssue"
         WHERE "batchId" = $1
         ORDER BY "createdAt" DESC
         LIMIT $2`,
        batchId,
        limit
      ),
    ]);

    return NextResponse.json({ batchId, type, total, rows });
  } catch (error) {
    console.error("[api/admin/import-students/details] failed:", error);
    return NextResponse.json(
      {
        error:
          userFacingError(error, "이관 상세 내역을 불러오지 못했습니다."),
      },
      { status: 500 }
    );
  }
}
