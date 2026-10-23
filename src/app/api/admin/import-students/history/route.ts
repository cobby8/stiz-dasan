import { userFacingError } from "@/lib/user-facing-error";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";

interface ImportHistoryIssueRow {
  id: string;
  batchId: string;
  sheetName: string | null;
  rowNumber: number | null;
  severity: string;
  message: string;
  createdAt: Date;
}

interface ImportHistoryBatchRow {
  id: string;
  source: string;
  spreadsheetTitle: string | null;
  status: string;
  totalRows: number;
  registrationRows: number;
  vehicleRows: number;
  changeRows: number;
  teamRows: number;
  errorRows: number;
  message: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export async function GET() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  }

  try {
    const batches = await prisma.$queryRawUnsafe<ImportHistoryBatchRow[]>(
      `SELECT id, source, "spreadsheetTitle", status, "totalRows",
              "registrationRows", "vehicleRows", "changeRows", "teamRows",
              "errorRows", message, "createdAt", "completedAt"
       FROM "StudentSheetImportBatch"
       ORDER BY "createdAt" DESC
       LIMIT 5`
    );

    const batchIds = batches.map((batch) => batch.id);
    const issues = batchIds.length
      ? await prisma.$queryRawUnsafe<ImportHistoryIssueRow[]>(
          `SELECT id, "batchId", "sheetName", "rowNumber", severity, message, "createdAt"
           FROM (
             SELECT i.*,
                    row_number() OVER (
                      PARTITION BY i."batchId"
                      ORDER BY i."createdAt" DESC
                    ) AS rn
             FROM "StudentSheetImportIssue" i
             WHERE i."batchId" = ANY($1::text[])
           ) ranked
           WHERE rn <= 5
           ORDER BY "createdAt" DESC`,
          batchIds
        )
      : [];

    const issuesByBatch = new Map<string, ImportHistoryIssueRow[]>();
    for (const issue of issues) {
      const list = issuesByBatch.get(issue.batchId) ?? [];
      list.push(issue);
      issuesByBatch.set(issue.batchId, list);
    }

    return NextResponse.json({
      batches: batches.map((batch) => ({
        ...batch,
        message: batch.status === "FAILED"
          ? userFacingError(new Error(batch.message || ""), "자료 가져오기를 완료하지 못했습니다. 다시 시도해 주세요.")
          : batch.message,
        createdAt: batch.createdAt.toISOString(),
        completedAt: batch.completedAt?.toISOString() ?? null,
        issues: (issuesByBatch.get(batch.id) ?? []).map((issue) => ({
          id: issue.id,
          sheetName: issue.sheetName,
          rowNumber: issue.rowNumber,
          severity: issue.severity,
          message: issue.message,
          createdAt: issue.createdAt.toISOString(),
        })),
      })),
    });
  } catch (error) {
    console.error("[api/admin/import-students/history] failed:", error);
    return NextResponse.json(
      {
        error:
          userFacingError(error, "최근 이관 기록을 불러오지 못했습니다."),
      },
      { status: 500 }
    );
  }
}
