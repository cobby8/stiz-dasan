import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const STATUS_FILTERS = {
  all: "",
  attention: "AND d.status IN ('FAILED','PARTIAL','SKIPPED')",
  processing: "AND d.status = 'PENDING'",
  success: "AND d.status = 'SENT'",
} as const;

const CHANNEL_FILTERS = {
  all: "",
  in_app: "AND d.channel = 'IN_APP'",
  push: "AND d.channel = 'PUSH'",
} as const;

type DeliveryRow = {
  id: string;
  stableEventKey: string | null;
  recipientUserId: string | null;
  eventType: string;
  trigger: string | null;
  channel: string;
  status: string;
  attemptCount: number;
  errorCode: string | null;
  studentName: string | null;
  recipientName: string | null;
  recipientRole: string | null;
  updatedAt: Date;
  sentAt: Date | null;
  failedAt: Date | null;
  nextAttemptAt: Date | null;
};

function safeErrorMessage(code: string | null) {
  if (!code) return null;
  if (code === "NO_SUBSCRIPTION") return "푸시 구독이 없습니다. 사이트 내부 알림은 별도로 확인해 주세요.";
  if (code === "NOT_CONFIGURED" || code === "VAPID_NOT_CONFIGURED") return "푸시 발송 설정이 완료되지 않았습니다. 사이트 내부 알림은 별도로 확인해 주세요.";
  if (code === "PUSH_MAX_ATTEMPTS_EXHAUSTED") return "자동 재시도 한도를 초과했습니다.";
  if (code === "PARTIAL_DELIVERY_RETRY_SCHEDULED") return "일부 기기에 전달되지 않아 자동 재시도 중입니다.";
  return "전달에 실패해 관리자 확인이 필요합니다.";
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const statusKey = request.nextUrl.searchParams.get("status") ?? "all";
  const channelKey = request.nextUrl.searchParams.get("channel") ?? "all";
  const statusClause = STATUS_FILTERS[statusKey as keyof typeof STATUS_FILTERS] ?? STATUS_FILTERS.all;
  const channelClause = CHANNEL_FILTERS[channelKey as keyof typeof CHANNEL_FILTERS] ?? CHANNEL_FILTERS.all;

  try {
    const rows = await prisma.$queryRawUnsafe<DeliveryRow[]>(
      `SELECT d.id,d."stableEventKey",d."recipientUserId",d."eventType",d.trigger,d.channel,d.status,d."attemptCount",d."errorCode",d."updatedAt",d."sentAt",d."failedAt",d."nextAttemptAt",
              s.name AS "studentName",u.name AS "recipientName",u.role::text AS "recipientRole"
         FROM "NotificationDelivery" d
         LEFT JOIN "Student" s ON s.id=d."studentId"
         LEFT JOIN "User" u ON u.id=d."recipientUserId"
        WHERE d.source='AUTO'
          AND d."audienceScope"='INTERNAL'
          AND d.trigger IN ('ABSENCE','SHUTTLE_EXCEPTION')
          AND d.channel IN ('IN_APP','PUSH')
          ${statusClause}
          ${channelClause}
        ORDER BY CASE WHEN d.status IN ('FAILED','PARTIAL','SKIPPED') THEN 0 WHEN d.status='PENDING' THEN 1 ELSE 2 END,
                 d."updatedAt" DESC
        LIMIT 200`,
    );

    return NextResponse.json({
      deliveries: rows.map((row) => ({
        id: row.id,
        stableEventKey: row.stableEventKey,
        recipientUserId: row.recipientUserId,
        eventType: row.eventType,
        trigger: row.trigger,
        channel: row.channel,
        status: row.status,
        attemptCount: row.attemptCount,
        errorMessage: safeErrorMessage(row.errorCode),
        partialRetry: row.errorCode === "PARTIAL_DELIVERY_RETRY_SCHEDULED",
        studentName: row.studentName,
        recipientName: row.recipientName,
        recipientRole: row.recipientRole,
        updatedAt: row.updatedAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
        failedAt: row.failedAt?.toISOString() ?? null,
        nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[api/admin/operational-deliveries] failed:", error);
    return NextResponse.json({ error: "전달 장부를 불러오지 못했습니다." }, { status: 500 });
  }
}
