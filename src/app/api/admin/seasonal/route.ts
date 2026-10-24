import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { cleanText, SeasonalError } from "@/lib/seasonal/contracts";
import { ensureInvoiceForPayment, ensurePaymentInfrastructure } from "@/lib/payment-ledger";
import { Prisma } from "@prisma/client";
import { classifyAdminAuthError } from "./auth-error";
import { sessionDateForKorea, syncOfferingSessionDates } from "@/lib/seasonal/session-bridge";
import { issueParentAccountClaim } from "@/lib/parent-account-claim";
import { isSyntheticParentEmail } from "@/lib/parent-synthetic-email";
import { randomUUID } from "node:crypto";
import { expireStaleSmsDeliveries } from "@/lib/notification";
import { getSeasonalAdminOverview } from "@/lib/seasonal/admin-overview";
import { resyncEnrollmentDatesForApplicationSafe, syncEnrollmentDatesForItemSafe, cancelEnrollmentDatesForItemSafe } from "@/lib/seasonal/enrollment-dates";
import { resolveOfferingPrice, resolveShuttleFee, type ApplicantType } from "@/lib/seasonal/planning";
import { syncSeasonSiblingDiscounts } from "@/lib/seasonal/sibling-discount-sync";
import {
  SEASONAL_SMS_TRIGGERS,
  dispatchSeasonalParentSms,
  reserveSeasonalParentSms,
  type SeasonalSmsDeliveryResult,
  type SeasonalSmsTrigger,
} from "@/lib/seasonal/notifications";

const SEASON_STATUSES = new Set(["DRAFT", "PUBLISHED", "CLOSED", "ARCHIVED"]);
const OFFERING_STATUSES = new Set(["DRAFT", "OPEN", "CLOSED", "CANCELLED"]);
const APPLICATION_STATUSES = new Set(["PENDING", "PARTIALLY_WAITLISTED", "APPROVED", "REJECTED", "CANCELLED"]);
const ITEM_STATUSES = new Set(["PENDING", "WAITLISTED", "APPROVED", "REJECTED", "CANCELLED"]);
type SessionDateInput = { id?: unknown; startsAt?: unknown; endsAt?: unknown; location?: unknown; note?: unknown };
type NotificationSummary = { trigger: string; status: string; attemptCount: number; updatedAt: string; errorCode: string | null; canRetry: boolean };
type NotificationDeliveryRow = { status: string; attemptCount: number; errorCode: string | null; updatedAt: Date; payloadJSON: unknown };
type SeasonalRosterRow = {
  itemId: string; applicationId: string; seasonId: string; seasonTitle: string; offeringId: string; offeringTitle: string;
  childName: string; childGrade: string | null; childSchool: string | null; parentName: string; parentPhone: string;
  priceSnapshot: number; itemStatus: string; createdAt: Date; paymentStatus: string; invoiceNo: string | null;
  shuttleRequested: boolean; shuttleUnassigned: boolean; weekdays: number[];
};
type SeasonalRosterStats = { confirmedSeats: number; heldSeats: number; unpaid: number; shuttleRequested: number; shuttleUnassigned: number; total: number };
type ConversionResult = { itemId: string; studentId: string; enrollmentId: string | null; paymentId: string; invoiceId: string | null; activationRequired: boolean; notification: SeasonalSmsDeliveryResult; notificationWarning?: true };
type AdminApplicationRow = Record<string, unknown> & {
  items: Array<Record<string, unknown> & { paymentId?: string | null }>;
};
type BulkItemResult = {
  itemId: string;
  ok: boolean;
  status?: string;
  applicationId?: string;
  invoiceId?: string | null;
  activationUrl?: string | null;
  activationRequired?: boolean;
  notification?: SeasonalSmsDeliveryResult;
  notificationWarning?: boolean;
  message?: string;
  code?: string;
};

const ITEM_NOTIFICATION_TRIGGER: Partial<Record<string, SeasonalSmsTrigger>> = {
  APPROVED: SEASONAL_SMS_TRIGGERS.approved,
  WAITLISTED: SEASONAL_SMS_TRIGGERS.waitlisted,
  REJECTED: SEASONAL_SMS_TRIGGERS.rejected,
  CANCELLED: SEASONAL_SMS_TRIGGERS.cancelled,
};

const WEEKDAY_KEYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
type WeekdayKey = (typeof WEEKDAY_KEYS)[number];
const WEEKDAY_FROM_EN_SHORT: Record<string, WeekdayKey> = {
  Mon: "MON", Tue: "TUE", Wed: "WED", Thu: "THU", Fri: "FRI", Sat: "SAT", Sun: "SUN",
};
const ASSIGNMENT_REVIEW_REASONS = new Set(["MISSING_WEEKDAYS", "MISSING_TUITION", "SHUTTLE_REQUEST_PENDING_ITEM"]);
const APPROVED_SEAT_STATUSES = ["APPROVED"];

function notificationNeedsWarning(result: SeasonalSmsDeliveryResult | null | undefined) {
  return Boolean(result && (result.status === "FAILED" || result.errorCode === "TEMPLATE_DISABLED_OR_MISSING"));
}

function notificationSummary(result: SeasonalSmsDeliveryResult, trigger: SeasonalSmsTrigger): NotificationSummary {
  return {
    trigger,
    status: result.status,
    attemptCount: result.status === "SKIPPED" ? 0 : 1,
    updatedAt: new Date().toISOString(),
    errorCode: result.errorCode ?? null,
    canRetry: true,
  };
}

function deliveryEventId(applicationId: string, itemId: string | null | undefined, trigger: string) {
  return [applicationId, itemId || "application", trigger].join(":");
}

function latestDeliverySummaries(rows: NotificationDeliveryRow[]) {
  const summaries = new Map<string, NotificationSummary>();
  for (const row of rows) {
    const payload = row.payloadJSON && typeof row.payloadJSON === "object" ? row.payloadJSON as Record<string, unknown> : {};
    const eventId = typeof payload.eventId === "string" ? payload.eventId : null;
    const trigger = typeof payload.trigger === "string" ? payload.trigger : null;
    if (!eventId || !trigger || summaries.has(eventId)) continue;
    summaries.set(eventId, {
      trigger,
      status: row.status,
      attemptCount: row.attemptCount,
      updatedAt: new Date(row.updatedAt).toISOString(),
      errorCode: row.errorCode,
      canRetry: row.status !== "PENDING",
    });
  }
  return summaries;
}

function newestNotification(summaries: Array<NotificationSummary | undefined>) {
  return summaries
    .filter((summary): summary is NotificationSummary => Boolean(summary))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] ?? null;
}

async function notifyItemStatus(result: Awaited<ReturnType<typeof updateSpecialProgramItemStatus>>) {
  const trigger = ITEM_NOTIFICATION_TRIGGER[result.item.status];
  if (!result.changed || !trigger || !result.reservation) return null;
  if (result.reservation.status !== "PENDING" || !result.reservation.deliveryId) return result.reservation;
  return dispatchSeasonalParentSms({
    deliveryId: result.reservation.deliveryId,
    trigger,
    recipientPhone: result.before.application.parentPhone,
    variables: {
      childName: result.before.application.childName,
      parentName: result.before.application.parentName,
      offeringTitle: result.before.offering.title,
      seasonTitle: "",
      waitlistOrder: result.item.waitlistOrder ? String(result.item.waitlistOrder) : "",
    },
  });
}

async function admin() {
  try {
    return await requireAdmin();
  } catch (error) {
    const authFailure = classifyAdminAuthError(error);
    if (authFailure) {
      throw new SeasonalError(authFailure.message, authFailure.status, authFailure.code);
    }
    throw error;
  }
}

function date(value: unknown, label: string) {
  const parsed = new Date(String(value || ""));
  if (Number.isNaN(parsed.getTime())) throw new SeasonalError(`${label}을 확인해 주세요.`);
  return parsed;
}

function nonNegativeInt(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new SeasonalError(`${label}은 0 이상의 정수여야 합니다.`);
  return parsed;
}

function optionalNonNegativeInt(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  return nonNegativeInt(value, label);
}

function normalizeDigits(value: string) {
  return value.replace(/[^0-9]/g, "");
}

function defaultPaymentDueDate() {
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 7);
  return dueDate;
}

function publicUrl(path: string) {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!configured || !/^https?:\/\//i.test(configured)) return path;
  return new URL(path, configured).toString();
}

const ROSTER_WEEKDAYS: Record<string, number> = { MON: 1, 월: 1, TUE: 2, 화: 2, WED: 3, 수: 3, THU: 4, 목: 4, FRI: 5, 금: 5, SAT: 6, 토: 6, SUN: 7, 일: 7 };

function rosterInt(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function seasonalApplicationWhere(params: URLSearchParams) {
  const seasonId = cleanText(params.get("seasonId"), 100) || null;
  const status = cleanText(params.get("status"), 30)?.toUpperCase() || null;
  const query = cleanText(params.get("q"), 100) || null;
  const where: Prisma.SpecialProgramApplicationWhereInput = {};

  if (seasonId) where.seasonId = seasonId;
  // 취소자 탭 전용 값: ACTIVE = 취소 아닌 신청(진행), CANCELLED_ONLY = 완전 취소된 신청만.
  if (status === "ACTIVE") {
    where.status = { not: "CANCELLED" };
  } else if (status === "CANCELLED_ONLY") {
    where.status = "CANCELLED";
  } else if (status && status !== "ALL") {
    const statusOr = [
      ...(APPLICATION_STATUSES.has(status) ? [{ status }] : []),
      ...(ITEM_STATUSES.has(status) ? [{ items: { some: { status } } }] : []),
    ];
    if (statusOr.length > 0) where.OR = statusOr;
  }
  if (query) {
    const searchOr = [
      { childName: { contains: query, mode: "insensitive" as const } },
      { childSchool: { contains: query, mode: "insensitive" as const } },
      { parentName: { contains: query, mode: "insensitive" as const } },
      { parentPhone: { contains: query } },
    ];
    where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { OR: searchOr }];
  }

  return where;
}

function maskedPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7) return "***";
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

function maskedName(value: string) {
  if (!value) return "";
  return `${value[0]}${"○".repeat(Math.max(1, value.length - 1))}`;
}

async function seasonalRoster(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const seasonId = cleanText(params.get("seasonId"), 100) || null;
  const offeringId = cleanText(params.get("offeringId"), 100) || null;
  const weekdayRaw = cleanText(params.get("weekday"), 10)?.toUpperCase() || null;
  const weekday = weekdayRaw ? (ROSTER_WEEKDAYS[weekdayRaw] ?? Number(weekdayRaw)) : null;
  if (weekday !== null && (!Number.isInteger(weekday) || weekday < 1 || weekday > 7)) throw new SeasonalError("요일 필터를 확인해 주세요.", 400, "INVALID_WEEKDAY");
  const rosterDate = cleanText(params.get("date"), 20) || null;
  if (rosterDate && !/^\d{4}-\d{2}-\d{2}$/.test(rosterDate)) throw new SeasonalError("출석 날짜를 확인해 주세요.", 400, "INVALID_ROSTER_DATE");
  const paymentStatus = cleanText(params.get("paymentStatus"), 30)?.toUpperCase() || null;
  const shuttleStatus = cleanText(params.get("shuttleStatus"), 30)?.toUpperCase() || null;
  const query = cleanText(params.get("q"), 100) || null;
  const page = rosterInt(params.get("page"), 1, 1, 1_000_000);
  const pageSize = rosterInt(params.get("pageSize"), 25, 1, 100);
  const offset = (page - 1) * pageSize;
  const paymentStatusSql = `CASE
    WHEN payment.status IN ('PAID','COMPLETED') OR invoice.status IN ('PAID','COMPLETED') THEN 'PAID'
    WHEN invoice.status = 'OVERDUE' OR payment.status = 'OVERDUE' THEN 'UNPAID'
    WHEN payment.id IS NULL AND invoice.id IS NULL THEN 'UNPAID'
    ELSE 'PAYMENT_PENDING' END`;
  const filterSql = `
    ($1::text IS NULL OR app."seasonId" = $1)
    AND ($2::text IS NULL OR EXISTS (
      SELECT 1 FROM "SpecialProgramOffering" filter_offering
       WHERE filter_offering.id = $2
         AND (
           item."offeringId" = filter_offering.id
           OR (
             filter_offering."linkedClassId" IS NOT NULL
             AND offering."linkedClassId" = filter_offering."linkedClassId"
             AND offering."seasonId" = filter_offering."seasonId"
           )
         )
    ))
    AND ($3::int IS NULL OR COALESCE(cardinality(app."selectedWeekdays"), 0) = 0 OR
      CASE $3::int
        WHEN 1 THEN 'MON' WHEN 2 THEN 'TUE' WHEN 3 THEN 'WED' WHEN 4 THEN 'THU'
        WHEN 5 THEN 'FRI' WHEN 6 THEN 'SAT' ELSE 'SUN'
      END = ANY(app."selectedWeekdays"))
    AND ($7::date IS NULL OR EXISTS (
      SELECT 1
        FROM "SpecialProgramSessionDate" date_sd
        JOIN "SpecialProgramOffering" date_offering ON date_offering.id = date_sd."offeringId"
       WHERE (
         date_offering.id = item."offeringId"
         OR (
           date_offering."linkedClassId" IS NOT NULL
           AND offering."linkedClassId" = date_offering."linkedClassId"
           AND offering."seasonId" = date_offering."seasonId"
         )
       )
         AND (date_sd."startsAt" AT TIME ZONE 'Asia/Seoul')::date = $7::date
         AND (
           COALESCE(cardinality(app."selectedWeekdays"), 0) = 0
           OR CASE EXTRACT(ISODOW FROM date_sd."startsAt" AT TIME ZONE 'Asia/Seoul')::int
             WHEN 1 THEN 'MON' WHEN 2 THEN 'TUE' WHEN 3 THEN 'WED' WHEN 4 THEN 'THU'
             WHEN 5 THEN 'FRI' WHEN 6 THEN 'SAT' ELSE 'SUN'
           END = ANY(app."selectedWeekdays")
         )
    ))
    AND ($4::text IS NULL OR ${paymentStatusSql} = $4)
    AND ($5::text IS NULL OR CASE
      WHEN $5 = 'REQUESTED' THEN shuttle.id IS NOT NULL
      WHEN $5 = 'NOT_USED' THEN shuttle.id IS NULL
      WHEN $5 = 'UNASSIGNED' THEN shuttle.id IS NOT NULL AND (shuttle."assignedRouteId" IS NULL OR shuttle."assignedStopId" IS NULL)
      WHEN $5 = 'ASSIGNED' THEN shuttle."assignedRouteId" IS NOT NULL AND shuttle."assignedStopId" IS NOT NULL
      ELSE shuttle.status = $5 END)
    AND ($6::text IS NULL OR app."childName" ILIKE '%' || $6 || '%' OR app."parentName" ILIKE '%' || $6 || '%'
      OR (regexp_replace($6, '[^0-9]', '', 'g') <> '' AND app."parentPhone" LIKE '%' || regexp_replace($6, '[^0-9]', '', 'g') || '%')
      OR COALESCE(app."childSchool", '') ILIKE '%' || $6 || '%')`;
  const queryParams = [seasonId, offeringId, weekday, paymentStatus, shuttleStatus, query, rosterDate];
  const [rows, totals] = await Promise.all([
    prisma.$queryRawUnsafe<SeasonalRosterRow[]>(`
      SELECT item.id AS "itemId", app.id AS "applicationId", app."seasonId", season.title AS "seasonTitle",
             item."offeringId", COALESCE(linked_class.name, offering.title) AS "offeringTitle", app."childName", app."childGrade", app."childSchool",
             app."parentName", app."parentPhone", item."priceSnapshot", item.status AS "itemStatus", item."createdAt",
             ${paymentStatusSql} AS "paymentStatus", invoice."invoiceNo",
             (shuttle.id IS NOT NULL) AS "shuttleRequested",
             (shuttle.id IS NOT NULL AND (shuttle."assignedRouteId" IS NULL OR shuttle."assignedStopId" IS NULL)) AS "shuttleUnassigned",
             CASE WHEN COALESCE(cardinality(app."selectedWeekdays"), 0) > 0 THEN
               COALESCE((SELECT array_agg(day_num ORDER BY day_num)
                           FROM (
                             SELECT DISTINCT CASE selected.day_key
                               WHEN 'MON' THEN 1 WHEN 'TUE' THEN 2 WHEN 'WED' THEN 3 WHEN 'THU' THEN 4
                               WHEN 'FRI' THEN 5 WHEN 'SAT' THEN 6 WHEN 'SUN' THEN 7 ELSE NULL
                             END AS day_num
                               FROM unnest(app."selectedWeekdays") AS selected(day_key)
                           ) selected_days WHERE day_num IS NOT NULL), ARRAY[]::int[])
             ELSE
               COALESCE((SELECT array_agg(session_day ORDER BY session_day)
                           FROM (
                             SELECT DISTINCT EXTRACT(ISODOW FROM sd."startsAt" AT TIME ZONE 'Asia/Seoul')::int AS session_day
                               FROM "SpecialProgramSessionDate" sd WHERE sd."offeringId" = item."offeringId"
                           ) actual_session_days), ARRAY[]::int[])
             END AS weekdays
        FROM "SpecialProgramApplicationItem" item
        JOIN "SpecialProgramApplication" app ON app.id = item."applicationId"
        JOIN "SpecialProgramSeason" season ON season.id = app."seasonId"
        JOIN "SpecialProgramOffering" offering ON offering.id = item."offeringId"
        LEFT JOIN "Class" linked_class ON linked_class.id = offering."linkedClassId"
        LEFT JOIN "Payment" payment ON payment.id = item."paymentId"
        LEFT JOIN "PaymentInvoice" invoice ON invoice."paymentId" = item."paymentId"
        LEFT JOIN "SpecialProgramShuttleRequest" shuttle ON shuttle."applicationItemId" = item.id
       WHERE item.status = 'APPROVED' AND ${filterSql}
       ORDER BY COALESCE((SELECT MIN(CASE selected.day_key
                  WHEN 'MON' THEN 1 WHEN 'TUE' THEN 2 WHEN 'WED' THEN 3 WHEN 'THU' THEN 4
                  WHEN 'FRI' THEN 5 WHEN 'SAT' THEN 6 WHEN 'SUN' THEN 7 ELSE NULL
                END) FROM unnest(app."selectedWeekdays") AS selected(day_key)), 8),
                offering."displayOrder", app."childName", item.id LIMIT $8 OFFSET $9`, ...queryParams, pageSize, offset),
    prisma.$queryRawUnsafe<Array<SeasonalRosterStats>>(`
      SELECT COUNT(*) FILTER (WHERE item.status = 'APPROVED')::int AS "confirmedSeats",
             COUNT(*) FILTER (WHERE item.status IN ('PENDING','APPROVED'))::int AS "heldSeats",
             COUNT(*) FILTER (WHERE item.status = 'APPROVED' AND ${paymentStatusSql} <> 'PAID')::int AS unpaid,
             COUNT(*) FILTER (WHERE item.status = 'APPROVED' AND shuttle.id IS NOT NULL)::int AS "shuttleRequested",
             COUNT(*) FILTER (WHERE item.status = 'APPROVED' AND shuttle.id IS NOT NULL AND (shuttle."assignedRouteId" IS NULL OR shuttle."assignedStopId" IS NULL))::int AS "shuttleUnassigned",
             COUNT(*) FILTER (WHERE item.status = 'APPROVED')::int AS total
        FROM "SpecialProgramApplicationItem" item
        JOIN "SpecialProgramApplication" app ON app.id = item."applicationId"
        JOIN "SpecialProgramOffering" offering ON offering.id = item."offeringId"
        LEFT JOIN "Payment" payment ON payment.id = item."paymentId"
        LEFT JOIN "PaymentInvoice" invoice ON invoice."paymentId" = item."paymentId"
        LEFT JOIN "SpecialProgramShuttleRequest" shuttle ON shuttle."applicationItemId" = item.id
       WHERE item.status IN ('PENDING','APPROVED') AND ${filterSql}`, ...queryParams),
  ]);
  const stats = totals[0] ?? { confirmedSeats: 0, heldSeats: 0, unpaid: 0, shuttleRequested: 0, shuttleUnassigned: 0, total: 0 };
  const weekdayLabels = ["", "월", "화", "수", "목", "금", "토", "일"];
  const rosterRows = rows.map((row) => {
    const weekdays = row.weekdays.map((day) => weekdayLabels[day]).filter(Boolean);
    return {
      ...row,
      id: row.itemId,
      seasonName: row.seasonTitle,
      offeringName: row.offeringTitle,
      weekday: weekdays.join("·"),
      scheduleLabel: weekdays.map((day) => `${day}요일`).join(", "),
      parentName: maskedName(row.parentName),
      parentPhone: maskedPhone(row.parentPhone),
      shuttleStatus: !row.shuttleRequested ? "NOT_USED" : row.shuttleUnassigned ? "UNASSIGNED" : "ASSIGNED",
      createdAt: row.createdAt.toISOString(),
    };
  });
  const pagination = { page, pageSize, total: stats.total, totalPages: Math.ceil(stats.total / pageSize) };
  return NextResponse.json({
    roster: { rows: rosterRows, stats, pagination },
    stats,
    pagination,
    filters: { seasonId, offeringId, weekday, date: rosterDate, paymentStatus, shuttleStatus, q: query },
  });
}

async function ensureApplicationCapacity(tx: Prisma.TransactionClient, applicationId: string) {
  const items = await tx.specialProgramApplicationItem.findMany({
    where: { applicationId },
    include: { application: { select: { selectedWeekdays: true } } },
    orderBy: { offeringId: "asc" },
  });
  for (const item of items) {
    if (item.status === "APPROVED") {
      await ensureSpecialProgramOperationalCapacity(tx, {
        offeringId: item.offeringId,
        selectedWeekdays: item.application.selectedWeekdays,
        excludeItemId: item.id,
      });
    }
  }
}

function applicationStatusFromItemStatuses(statuses: string[]) {
  if (statuses.every((status) => status === "APPROVED")) return "APPROVED";
  if (statuses.every((status) => status === "REJECTED")) return "REJECTED";
  if (statuses.every((status) => status === "CANCELLED")) return "CANCELLED";
  if (statuses.includes("WAITLISTED")) return "PARTIALLY_WAITLISTED";
  return "PENDING";
}

function parseBulkItemIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => cleanText(item, 100)).filter((item): item is string => Boolean(item))));
}

function bulkErrorResult(itemId: string, error: unknown): BulkItemResult {
  if (error instanceof SeasonalError) {
    return { itemId, ok: false, message: error.message, code: error.code };
  }
  console.error("[admin seasonal bulk item]", error);
  return { itemId, ok: false, message: "처리 중 오류가 발생했습니다.", code: "BULK_ITEM_FAILED" };
}

async function updateSpecialProgramItemStatus(
  tx: Prisma.TransactionClient,
  params: { itemId: string; status: string; actorId: string; enrollmentId?: unknown; paymentId?: unknown; deliveryRunId?: string },
) {
  const before = await tx.specialProgramApplicationItem.findUnique({
    where: { id: params.itemId },
    include: { application: true, offering: { select: { title: true } } },
  });
  if (!before) throw new SeasonalError("신청 항목을 찾을 수 없습니다.", 404);
  if (params.status === "APPROVED" && (before.application.requiresReview || before.application.reviewReasons.length > 0)) {
    throw new SeasonalError("검토 필요 사유를 먼저 확인하고 검토 완료 처리해 주세요.", 409, "APPLICATION_REVIEW_REQUIRED");
  }

  if (params.status === "APPROVED") {
    await ensureSpecialProgramOperationalCapacity(tx, {
      offeringId: before.offeringId,
      selectedWeekdays: before.application.selectedWeekdays,
      excludeItemId: params.itemId,
    });
  }

  let waitlistOrder = before.waitlistOrder;
  if (params.status === "WAITLISTED" && !waitlistOrder) {
    const last = await tx.specialProgramApplicationItem.aggregate({ where: { offeringId: before.offeringId, status: "WAITLISTED" }, _max: { waitlistOrder: true } });
    waitlistOrder = (last._max.waitlistOrder || 0) + 1;
  }

  const changed = before.status !== params.status;
  const item = await tx.specialProgramApplicationItem.update({
    where: { id: params.itemId },
    data: {
      status: params.status,
      waitlistOrder: params.status === "WAITLISTED" ? waitlistOrder : null,
      enrollmentId: cleanText(params.enrollmentId, 100),
      paymentId: cleanText(params.paymentId, 100),
    },
  });
  const siblings = await tx.specialProgramApplicationItem.findMany({
    where: { applicationId: before.applicationId },
    select: { status: true },
  });
  await tx.specialProgramApplication.update({
    where: { id: before.applicationId },
    data: { status: applicationStatusFromItemStatuses(siblings.map((row) => row.status)), processedAt: new Date(), processedByUserId: params.actorId },
  });
  if (changed) await tx.specialProgramAuditLog.create({
    data: {
      seasonId: before.application.seasonId,
      offeringId: item.offeringId,
      applicationId: item.applicationId,
      itemId: params.itemId,
      actorType: "ADMIN",
      actorId: params.actorId,
      action: "ITEM_STATUS_UPDATED",
      beforeJSON: before,
      afterJSON: item,
    },
  });
  const trigger = ITEM_NOTIFICATION_TRIGGER[item.status];
  const reservation = changed && trigger ? await reserveSeasonalParentSms(tx, {
    trigger,
    applicationId: item.applicationId,
    itemId: item.id,
    recipientPhone: before.application.parentPhone,
    deliveryRunId: params.deliveryRunId,
  }) : null;
  return { item, before, changed, reservation };
}

function normalizeSelectedWeekdays(value: unknown) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,/]+/)
      : [];
  const days = raw
    .map((item) => cleanText(item, 10)?.toUpperCase())
    .map((item) => (item ? ROSTER_WEEKDAYS[item] : null))
    .filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item >= 1 && item <= 7);
  return Array.from(new Set(days)).sort((left, right) => left - right).map((day) => WEEKDAY_KEYS[day - 1]);
}

// 관리자 재배정 금액은 공개 신청과 같은 함수(resolveOfferingPrice / resolveShuttleFee)를 쓴다.
// 예전에는 여기에 같은 계산이 한 벌 더 있어서, 한쪽만 고치면 반 재배정 순간 금액 규칙이 갈라졌다.
function seasonalApplicantType(value?: string | null): ApplicantType | undefined {
  return value === "EXISTING" || value === "NEW" ? value : undefined;
}

function seasonalOfferingFrequency(offering: { title?: string | null; code?: string | null }) {
  const source = `${offering.title ?? ""} ${offering.code ?? ""}`;
  const matched = source.match(/주\s*(\d+)\s*회|-(\d)(?:\D|$)/i);
  const value = matched ? Number(matched[1] ?? matched[2]) : NaN;
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function offeringSessionWeekdays(tx: Prisma.TransactionClient, offeringId: string) {
  const dates = await tx.specialProgramSessionDate.findMany({
    where: { offeringId },
    select: { startsAt: true },
  });
  const days = dates
    .map((date) => {
      const short = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(date.startsAt);
      return WEEKDAY_FROM_EN_SHORT[short] ?? null;
    })
    .filter((day): day is WeekdayKey => Boolean(day));
  return Array.from(new Set(days));
}

async function resolveSpecialProgramAssignment(
  tx: Prisma.TransactionClient,
  params: { offeringId: string; selectedWeekdays: string[]; applicationSeasonId: string; applicantType?: string | null },
) {
  const target = await tx.specialProgramOffering.findUnique({ where: { id: params.offeringId } });
  if (!target || target.seasonId !== params.applicationSeasonId) {
    throw new SeasonalError("같은 시즌의 특강 반을 선택해 주세요.", 400, "OFFERING_NOT_FOUND");
  }
  const selectedCount = params.selectedWeekdays.length;
  const scopeWhere = target.linkedClassId
    ? { seasonId: target.seasonId, linkedClassId: target.linkedClassId }
    : { id: target.id };
  const candidates = await tx.specialProgramOffering.findMany({
    where: scopeWhere,
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  });
  const offering = candidates.find((candidate) => seasonalOfferingFrequency(candidate) === selectedCount) ?? target;
  return {
    offering,
    // 할인 전 수강료(기존회원가 반영까지). 형제할인은 저장 뒤 syncSeasonSiblingDiscounts가 따로 얹는다.
    priceSnapshot: resolveOfferingPrice(offering, seasonalApplicantType(params.applicantType)),
  };
}

async function ensureSpecialProgramOperationalCapacity(
  tx: Prisma.TransactionClient,
  params: { offeringId: string; selectedWeekdays?: string[] | null; excludeItemId?: string; statuses?: string[] },
) {
  const target = await tx.specialProgramOffering.findUnique({ where: { id: params.offeringId } });
  if (!target) throw new SeasonalError("배정할 특강 반을 찾을 수 없습니다.", 404, "OFFERING_NOT_FOUND");
  const scopeWhere = target.linkedClassId
    ? { seasonId: target.seasonId, linkedClassId: target.linkedClassId }
    : { id: target.id };
  const scopedOfferings = await tx.specialProgramOffering.findMany({
    where: scopeWhere,
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const scopedOfferingIds = scopedOfferings.map((offering) => offering.id);
  if (scopedOfferingIds.length > 0) {
    await tx.$queryRaw`SELECT id FROM "SpecialProgramOffering" WHERE id IN (${Prisma.join(scopedOfferingIds)}) ORDER BY id FOR UPDATE`;
  }

  const selectedWeekdays = normalizeSelectedWeekdays(params.selectedWeekdays ?? []);
  const effectiveWeekdays = selectedWeekdays.length > 0 ? selectedWeekdays : await offeringSessionWeekdays(tx, target.id);
  if (target.capacity === null || effectiveWeekdays.length === 0) return target;

  const statuses = params.statuses?.length ? params.statuses : APPROVED_SEAT_STATUSES;
  for (const weekday of effectiveWeekdays) {
    const rows = await tx.$queryRaw<Array<{ occupied: bigint }>>(Prisma.sql`
      SELECT COUNT(DISTINCT item.id)::bigint AS occupied
        FROM "SpecialProgramApplicationItem" item
        JOIN "SpecialProgramOffering" candidate ON candidate.id = item."offeringId"
        JOIN "SpecialProgramApplication" app ON app.id = item."applicationId"
       WHERE item.status IN (${Prisma.join(statuses)})
         ${params.excludeItemId ? Prisma.sql`AND item.id <> ${params.excludeItemId}` : Prisma.empty}
         ${target.linkedClassId
           ? Prisma.sql`AND candidate."seasonId" = ${target.seasonId} AND candidate."linkedClassId" = ${target.linkedClassId}`
           : Prisma.sql`AND candidate.id = ${target.id}`}
         AND (
           COALESCE(cardinality(app."selectedWeekdays"), 0) = 0
           OR ${weekday} = ANY(app."selectedWeekdays")
         )
    `);
    const occupied = Number(rows[0]?.occupied ?? 0);
    if (occupied >= target.capacity) {
      const dayLabel = ["월", "화", "수", "목", "금", "토", "일"][WEEKDAY_KEYS.indexOf(weekday as WeekdayKey)] ?? weekday;
      throw new SeasonalError(`${dayLabel}요일 정원이 가득 차 승인할 수 없습니다.`, 409, "CAPACITY_FULL");
    }
  }
  return target;
}

async function refreshApplicationSummary(tx: Prisma.TransactionClient, applicationId: string, actorId: string) {
  const items = await tx.specialProgramApplicationItem.findMany({
    where: { applicationId },
    select: { status: true, priceSnapshot: true },
  });
  return tx.specialProgramApplication.update({
    where: { id: applicationId },
    data: {
      status: items.length ? applicationStatusFromItemStatuses(items.map((item) => item.status)) : "PENDING",
      totalPriceSnapshot: items.reduce((sum, item) => sum + item.priceSnapshot, 0),
      processedAt: new Date(),
      processedByUserId: actorId,
    },
  });
}

async function updateOperationalOfferingInstructor(
  tx: Prisma.TransactionClient,
  params: { offeringId: string; instructorId: string | null; instructorName: string | null; actorId: string },
) {
  const target = await tx.specialProgramOffering.findUnique({ where: { id: params.offeringId } });
  if (!target) throw new SeasonalError("담당 선생님을 배정할 특강 반을 찾을 수 없습니다.", 404, "OFFERING_NOT_FOUND");

  const scopeWhere = target.linkedClassId
    ? { seasonId: target.seasonId, linkedClassId: target.linkedClassId }
    : { id: target.id };
  const offerings = await tx.specialProgramOffering.findMany({
    where: scopeWhere,
    include: {
      sessionDates: {
        orderBy: { startsAt: "asc" },
        select: { id: true, startsAt: true, endsAt: true, location: true, note: true },
      },
    },
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  });

  const updated = [];
  for (const offering of offerings) {
    const saved = await tx.specialProgramOffering.update({
      where: { id: offering.id },
      data: {
        instructorId: params.instructorId,
        instructorName: params.instructorName,
      },
    });
    await syncOfferingSessionDates(tx, {
      offeringId: offering.id,
      linkedClassId: offering.linkedClassId,
      instructorId: params.instructorId,
      dates: offering.sessionDates,
    });
    await tx.specialProgramAuditLog.create({
      data: {
        seasonId: offering.seasonId,
        offeringId: offering.id,
        actorType: "ADMIN",
        actorId: params.actorId,
        action: "OFFERING_INSTRUCTOR_UPDATED",
        beforeJSON: { instructorId: offering.instructorId, instructorName: offering.instructorName },
        afterJSON: { instructorId: params.instructorId, instructorName: params.instructorName },
      },
    });
    updated.push(saved);
  }

  return {
    offering: updated.find((offering) => offering.id === target.id) ?? updated[0] ?? target,
    updatedCount: updated.length,
  };
}

function weekdayNumberFromKey(weekday: string) {
  const normalized = normalizeSelectedWeekdays([weekday])[0];
  return normalized ? ROSTER_WEEKDAYS[normalized] : null;
}

async function updateOperationalSlotInstructor(
  tx: Prisma.TransactionClient,
  params: { offeringId: string; weekday: string; instructorId: string | null; instructorName: string | null; actorId: string },
) {
  const weekdayNumber = weekdayNumberFromKey(params.weekday);
  if (!weekdayNumber) throw new SeasonalError("담당 선생님을 배정할 요일을 선택해 주세요.", 400, "WEEKDAY_REQUIRED");
  const target = await tx.specialProgramOffering.findUnique({ where: { id: params.offeringId } });
  if (!target) throw new SeasonalError("담당 선생님을 배정할 운영반을 찾을 수 없습니다.", 404, "OFFERING_NOT_FOUND");
  if (!target.linkedClassId) throw new SeasonalError("요일별 담당 배정을 하려면 먼저 출석에 연결할 반을 설정해 주세요.", 409, "LINKED_CLASS_REQUIRED");

  const sessionDates = await tx.specialProgramSessionDate.findMany({
    where: { offering: { seasonId: target.seasonId, linkedClassId: target.linkedClassId } },
    include: { session: { include: { _count: { select: { attendances: true } } } } },
    orderBy: { startsAt: "asc" },
  });
  const targetDates = sessionDates.filter((sessionDate) => {
    const day = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(sessionDate.startsAt);
    return WEEKDAY_FROM_EN_SHORT[day] && ROSTER_WEEKDAYS[WEEKDAY_FROM_EN_SHORT[day]] === weekdayNumber;
  });
  if (targetDates.length === 0) throw new SeasonalError("선택한 요일의 수업 일정이 없습니다.", 404, "SESSION_DATE_NOT_FOUND");

  const slots = new Map<string, typeof targetDates>();
  for (const sessionDate of targetDates) {
    const key = `${sessionDate.startsAt.toISOString()}:${sessionDate.endsAt.toISOString()}`;
    slots.set(key, [...(slots.get(key) ?? []), sessionDate]);
  }

  const touchedSessionIds = new Set<string>();
  for (const slotDates of slots.values()) {
    const existingSessions = slotDates.map((sessionDate) => sessionDate.session).filter(Boolean);
    for (const session of existingSessions) {
      if (!session) continue;
      if ((session.status !== "PLANNED" || session._count.attendances > 0) && session.coachId !== params.instructorId) {
        throw new SeasonalError("이미 시작했거나 출석 기록이 있는 회차의 담당 선생님은 변경할 수 없습니다.", 409, "SESSION_DATE_LOCKED");
      }
      await tx.session.update({ where: { id: session.id }, data: { coachId: params.instructorId } });
      touchedSessionIds.add(session.id);
    }
    if (existingSessions.length === 0) {
      const representative = slotDates[0];
      const session = await tx.session.create({
        data: {
          classId: target.linkedClassId,
          date: sessionDateForKorea(representative.startsAt),
          sessionKey: `seasonal:${representative.id}`,
          status: "PLANNED",
          coachId: params.instructorId,
          specialProgramSessionDateId: representative.id,
        },
      });
      touchedSessionIds.add(session.id);
    }
  }

  await tx.specialProgramAuditLog.create({
    data: {
      seasonId: target.seasonId,
      offeringId: target.id,
      actorType: "ADMIN",
      actorId: params.actorId,
      action: "OPERATIONAL_SLOT_INSTRUCTOR_UPDATED",
      afterJSON: {
        linkedClassId: target.linkedClassId,
        weekday: params.weekday,
        instructorId: params.instructorId,
        instructorName: params.instructorName,
        sessionCount: touchedSessionIds.size,
      },
    },
  });

  return { updatedCount: touchedSessionIds.size };
}

async function saveSpecialProgramItemAssignment(
  tx: Prisma.TransactionClient,
  params: { itemId: string; offeringId: string; selectedWeekdays: string[]; priceSnapshot: number; actorId: string },
) {
  const before = await tx.specialProgramApplicationItem.findUnique({
    where: { id: params.itemId },
    include: { application: true, offering: true, shuttleRequest: true },
  });
  if (!before) throw new SeasonalError("신청 반을 찾을 수 없습니다.", 404, "APPLICATION_ITEM_NOT_FOUND");
  if (before.enrollmentId || before.paymentId) {
    throw new SeasonalError("이미 수강 등록이나 청구서가 연결된 신청은 먼저 연결을 정리한 뒤 변경해 주세요.", 409, "ITEM_ALREADY_CONVERTED");
  }
  const assignment = await resolveSpecialProgramAssignment(tx, {
    offeringId: params.offeringId,
    selectedWeekdays: params.selectedWeekdays,
    applicationSeasonId: before.application.seasonId,
    applicantType: before.application.applicantType,
  });
  const offering = assignment.offering;
  const duplicated = await tx.specialProgramApplicationItem.findFirst({
    where: { applicationId: before.applicationId, offeringId: offering.id, id: { not: before.id } },
    select: { id: true },
  });
  if (duplicated) throw new SeasonalError("이미 같은 반으로 등록된 신청 항목이 있습니다.", 409, "OFFERING_ALREADY_ASSIGNED");
  if (before.status === "APPROVED") {
    await ensureSpecialProgramOperationalCapacity(tx, {
      offeringId: offering.id,
      selectedWeekdays: params.selectedWeekdays,
      excludeItemId: before.id,
    });
  }
  let waitlistOrder = before.waitlistOrder;
  if (before.status === "WAITLISTED" && before.offeringId !== offering.id) {
    const last = await tx.specialProgramApplicationItem.aggregate({ where: { offeringId: offering.id, status: "WAITLISTED" }, _max: { waitlistOrder: true } });
    waitlistOrder = (last._max.waitlistOrder || 0) + 1;
  }
  const shuttleFeeSnapshot = resolveShuttleFee(offering, Boolean(before.shuttleRequest));
  await tx.specialProgramApplicationItem.update({
    where: { id: before.id },
    data: {
      offeringId: offering.id,
      titleSnapshot: offering.title,
      tuitionPriceSnapshot: assignment.priceSnapshot,
      shuttleFeeSnapshot,
      // 할인은 아래 syncSeasonSiblingDiscounts가 "할인 전 수강료"에서 다시 계산해 덮어쓴다.
      // 여기서는 일단 할인 없는 금액으로 맞춰 두어 DB 제약(최종금액 = 수강료 - 할인 + 셔틀비)을 항상 만족시킨다.
      siblingDiscountSnapshot: 0,
      discountReasonSnapshot: null,
      priceSnapshot: assignment.priceSnapshot + shuttleFeeSnapshot,
      waitlistOrder: before.status === "WAITLISTED" ? waitlistOrder : null,
      conversionStatus: "NOT_STARTED",
      conversionError: null,
    },
  });
  // 반을 옮기면 수강료 자체가 바뀌므로 형제할인도 반드시 다시 계산해야 한다.
  // (이 호출이 빠지면 관리자가 반을 재배정하는 순간 할인이 조용히 사라진다.)
  await syncSeasonSiblingDiscounts(tx, before.application.seasonId);
  const item = await tx.specialProgramApplicationItem.findUniqueOrThrow({ where: { id: before.id } });
  const reviewReasons = before.application.reviewReasons.filter((reason) => !ASSIGNMENT_REVIEW_REASONS.has(reason));
  await tx.specialProgramApplication.update({
    where: { id: before.applicationId },
    data: {
      selectedWeekdays: params.selectedWeekdays,
      requiresReview: reviewReasons.length > 0,
      reviewReasons,
    },
  });
  const application = await refreshApplicationSummary(tx, before.applicationId, params.actorId);
  await tx.specialProgramAuditLog.create({
    data: {
      seasonId: before.application.seasonId,
      offeringId: item.offeringId,
      applicationId: item.applicationId,
      itemId: item.id,
      actorType: "ADMIN",
      actorId: params.actorId,
      action: "ITEM_ASSIGNMENT_UPDATED",
      beforeJSON: before,
      afterJSON: { item, selectedWeekdays: params.selectedWeekdays, application },
    },
  });
  return { item, application };
}

async function createSpecialProgramApplicationItem(
  tx: Prisma.TransactionClient,
  params: { applicationId: string; offeringId: string; selectedWeekdays: string[]; priceSnapshot: number; actorId: string },
) {
  const application = await tx.specialProgramApplication.findUnique({
    where: { id: params.applicationId },
    include: { items: { select: { offeringId: true } } },
  });
  if (!application) throw new SeasonalError("신청서를 찾을 수 없습니다.", 404, "APPLICATION_NOT_FOUND");
  const assignment = await resolveSpecialProgramAssignment(tx, {
    offeringId: params.offeringId,
    selectedWeekdays: params.selectedWeekdays,
    applicationSeasonId: application.seasonId,
    applicantType: application.applicantType,
  });
  const offering = assignment.offering;
  if (application.items.some((item) => item.offeringId === offering.id)) {
    throw new SeasonalError("이미 같은 반으로 등록된 신청 항목이 있습니다.", 409, "OFFERING_ALREADY_ASSIGNED");
  }
  const created = await tx.specialProgramApplicationItem.create({
    data: {
      applicationId: application.id,
      offeringId: offering.id,
      titleSnapshot: offering.title,
      priceSnapshot: assignment.priceSnapshot,
      tuitionPriceSnapshot: assignment.priceSnapshot,
      siblingDiscountSnapshot: 0,
      discountReasonSnapshot: null,
      shuttleFeeSnapshot: 0,
      status: "PENDING",
    },
  });
  // 관리자가 항목을 새로 만들 때도 형제할인 기준으로 금액을 다시 맞춘다.
  await syncSeasonSiblingDiscounts(tx, application.seasonId);
  const item = await tx.specialProgramApplicationItem.findUniqueOrThrow({ where: { id: created.id } });
  const reviewReasons = application.reviewReasons.filter((reason) => !ASSIGNMENT_REVIEW_REASONS.has(reason));
  await tx.specialProgramApplication.update({
    where: { id: application.id },
    data: {
      selectedWeekdays: params.selectedWeekdays,
      requiresReview: reviewReasons.length > 0,
      reviewReasons,
    },
  });
  const updatedApplication = await refreshApplicationSummary(tx, application.id, params.actorId);
  await tx.specialProgramAuditLog.create({
    data: {
      seasonId: application.seasonId,
      offeringId: item.offeringId,
      applicationId: application.id,
      itemId: item.id,
      actorType: "ADMIN",
      actorId: params.actorId,
      action: "ITEM_ASSIGNMENT_CREATED",
      afterJSON: { item, selectedWeekdays: params.selectedWeekdays, application: updatedApplication },
    },
  });
  return { item, application: updatedApplication };
}

function respondError(error: unknown) {
  if (error instanceof SeasonalError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && JSON.stringify(error.meta?.target ?? "").toLowerCase().includes("code")) {
    return NextResponse.json({ error: "같은 시즌에 이미 사용 중인 반 코드입니다. 다른 코드를 입력해 주세요.", code: "OFFERING_CODE_DUPLICATED" }, { status: 409 });
  }
  console.error("[admin seasonal]", error);
  return NextResponse.json({ error: "방학특강 관리 작업에 실패했습니다." }, { status: 500 });
}

export async function GET(request: NextRequest) {
  try {
    await admin();
    if (request.nextUrl.searchParams.get("view") === "roster") return seasonalRoster(request);
    const seasonId = request.nextUrl.searchParams.get("seasonId") || undefined;
    const includeApplications = request.nextUrl.searchParams.get("includeApplications") === "true";
    if (!includeApplications) return NextResponse.json(await getSeasonalAdminOverview(seasonId));
    const page = rosterInt(request.nextUrl.searchParams.get("page"), 1, 1, 1_000_000);
    const pageSize = rosterInt(request.nextUrl.searchParams.get("pageSize"), 30, 1, 100);
    const offset = (page - 1) * pageSize;
    const applicationWhere = seasonalApplicationWhere(request.nextUrl.searchParams);
    const [overview, applicationRows, totalApplications] = await Promise.all([
      getSeasonalAdminOverview(seasonId),
      prisma.specialProgramApplication.findMany({
        where: applicationWhere,
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: pageSize,
        include: {
          items: {
            include: {
              offering: { select: { title: true, code: true, linkedProgramId: true, linkedClassId: true } },
              shuttleRequest: true,
            },
          },
        },
      }),
      prisma.specialProgramApplication.count({ where: applicationWhere }),
    ]);
    const { seasons, stats } = overview;
    const paymentIds = Array.from(new Set(
      (applicationRows as AdminApplicationRow[]).flatMap((application) => application.items.map((item) => item.paymentId).filter(Boolean) as string[]),
    ));
    const invoiceRows = paymentIds.length
      ? await prisma.paymentInvoice.findMany({
          where: { paymentId: { in: paymentIds } },
          select: { id: true, paymentId: true, invoiceNo: true, status: true, amount: true, dueDate: true, checkoutUrl: true },
        })
      : [];
    const invoicesByPaymentId = new Map(invoiceRows.map((invoice) => [invoice.paymentId, invoice]));
    const activationRows = invoiceRows.length
      ? (await prisma.$queryRawUnsafe<Array<{ paymentId: string; email: string | null }>>(
          `SELECT i."paymentId", u.email
             FROM "PaymentInvoice" i JOIN "User" u ON u.id = i."parentId"
            WHERE i.id = ANY($1::text[])`,
          invoiceRows.map((invoice) => invoice.id),
        // 빈 보호자 계정 판정은 SQL 정규식 사본 대신 공용 규칙(parent-synthetic-email.ts) 한 곳으로 한다
        )).map((row) => ({ paymentId: row.paymentId, activationRequired: isSyntheticParentEmail(row.email) }))
      : [];
    const activationByPaymentId = new Map(activationRows.map((row) => [row.paymentId, row.activationRequired]));
    const visibleEventIds = (applicationRows as AdminApplicationRow[]).flatMap((application) => {
      const applicationId = String(application.id);
      const applicationEvents = Object.values(SEASONAL_SMS_TRIGGERS).map((trigger) => deliveryEventId(applicationId, null, trigger));
      const itemEvents = application.items.flatMap((item) => Object.values(SEASONAL_SMS_TRIGGERS)
        .map((trigger) => deliveryEventId(applicationId, String(item.id), trigger)));
      return [...applicationEvents, ...itemEvents];
    });
    const deliveryRows = visibleEventIds.length
      ? await prisma.$queryRawUnsafe<NotificationDeliveryRow[]>(
          `SELECT status, "attemptCount", "errorCode", "updatedAt", "payloadJSON"
             FROM "NotificationDelivery"
            WHERE "eventType" = 'SPECIAL_PROGRAM_NOTIFICATION'
              AND "payloadJSON"->>'eventId' = ANY($1::text[])
            ORDER BY "updatedAt" DESC`,
          visibleEventIds,
        )
      : [];
    const deliverySummaries = latestDeliverySummaries(deliveryRows);
    const statusTriggers = Object.values(ITEM_NOTIFICATION_TRIGGER).filter((trigger): trigger is SeasonalSmsTrigger => Boolean(trigger));
    const applications = (applicationRows as AdminApplicationRow[]).map((application) => ({
      ...application,
      notificationSummary: newestNotification([
        deliverySummaries.get(deliveryEventId(String(application.id), null, SEASONAL_SMS_TRIGGERS.received)),
        ...statusTriggers.map((trigger) => deliverySummaries.get(deliveryEventId(String(application.id), null, trigger))),
      ]),
      items: application.items.map((item) => {
        const applicationId = String(application.id);
        const itemId = String(item.id);
        const invoice = item.paymentId ? invoicesByPaymentId.get(item.paymentId) : null;
        return {
          ...item,
          notificationSummary: newestNotification(statusTriggers.map((trigger) => deliverySummaries.get(deliveryEventId(applicationId, itemId, trigger)))),
          invoice: invoice ? {
            ...invoice,
            accountActivationRequired: activationByPaymentId.get(item.paymentId!) ?? false,
            notificationSummary: newestNotification([
              deliverySummaries.get(deliveryEventId(applicationId, itemId, SEASONAL_SMS_TRIGGERS.accountActivation)),
              deliverySummaries.get(deliveryEventId(applicationId, itemId, SEASONAL_SMS_TRIGGERS.paymentRequest)),
            ]),
          } : null,
        };
      }),
    }));

    return NextResponse.json({
      seasons,
      applications,
      applicationsPagination: {
        page,
        pageSize,
        total: totalApplications,
        totalPages: Math.max(1, Math.ceil(totalApplications / pageSize)),
        hasMore: offset + applications.length < totalApplications,
      },
      stats,
    });
  } catch (error) { return respondError(error); }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await admin();
    const body = await request.json();
    const data = body?.data || {};
    if (body?.resource === "season") {
      const title = cleanText(data.title, 150);
      const slug = cleanText(data.slug, 100)?.toLowerCase();
      if (!title || !slug || !/^[a-z0-9-]+$/.test(slug)) throw new SeasonalError("시즌 이름과 영문 주소를 확인해 주세요.");
      const applicationOpensAt = date(data.applicationOpensAt, "신청 시작일");
      const applicationClosesAt = date(data.applicationClosesAt, "신청 마감일");
      const startsAt = date(data.startsAt, "수업 시작일");
      const endsAt = date(data.endsAt, "수업 종료일");
      if (applicationClosesAt <= applicationOpensAt || endsAt < startsAt) throw new SeasonalError("시작일과 종료일의 순서를 확인해 주세요.");
      const status = SEASON_STATUSES.has(data.status) ? data.status : "DRAFT";
      const season = await prisma.specialProgramSeason.create({ data: { slug, title, description: cleanText(data.description, 5000), applicationOpensAt, applicationClosesAt, startsAt, endsAt, status, termsText: cleanText(data.termsText, 10000), cancellationPolicy: cleanText(data.cancellationPolicy, 10000) } });
      await prisma.specialProgramAuditLog.create({ data: { seasonId: season.id, actorType: "ADMIN", actorId: actor.appUserId, action: "SEASON_CREATED", afterJSON: season } });
      return NextResponse.json({ season }, { status: 201 });
    }
    if (body?.resource === "offering") {
      const seasonId = cleanText(data.seasonId, 100);
      const title = cleanText(data.title, 150);
      const code = cleanText(data.code, 80)?.toUpperCase();
      if (!seasonId || !title || !code) throw new SeasonalError("시즌, 특강명, 코드는 필수입니다.");
      const capacity = optionalNonNegativeInt(data.capacity, "정원");
      const price = nonNegativeInt(data.price, "가격");
      const status = OFFERING_STATUSES.has(data.status) ? data.status : "DRAFT";
      const linkedClassId = cleanText(data.linkedClassId, 100) || null;
      const instructorId = cleanText(data.instructorId, 100) || null;
      const sessionDates = Array.isArray(data.sessionDates) ? (data.sessionDates as SessionDateInput[]).map((row) => ({ startsAt: date(row.startsAt, "수업 시작 시각"), endsAt: date(row.endsAt, "수업 종료 시각"), location: cleanText(row.location, 150), note: cleanText(row.note, 500) })) : [];
      if (sessionDates.some((row: { startsAt: Date; endsAt: Date }) => row.endsAt <= row.startsAt)) throw new SeasonalError("수업 종료 시각은 시작 시각보다 늦어야 합니다.");
      if (status === "OPEN" && capacity === null) throw new SeasonalError("정원이 정해지지 않은 반은 공개할 수 없습니다.", 409, "CAPACITY_REQUIRED");
      if (status === "OPEN" && sessionDates.length === 0) throw new SeasonalError("모집 중인 반은 수업 일정을 한 개 이상 등록해야 합니다.", 409, "SESSION_DATE_REQUIRED");
      const offering = await prisma.$transaction(async (tx) => {
        const created = await tx.specialProgramOffering.create({ data: { seasonId, code, title, description: cleanText(data.description, 5000), targetGrades: cleanText(data.targetGrades, 200), instructorId, instructorName: cleanText(data.instructorName, 100), location: cleanText(data.location, 150), capacity, price, newApplicantPrice: optionalNonNegativeInt(data.newApplicantPrice, "신규 회원 가격"), existingApplicantPrice: optionalNonNegativeInt(data.existingApplicantPrice, "기존 회원 가격"), shuttleAvailable: Boolean(data.shuttleAvailable), shuttleFee: nonNegativeInt(data.shuttleFee ?? 0, "셔틀비"), status, displayOrder: Number.isInteger(data.displayOrder) ? data.displayOrder : 0, linkedProgramId: cleanText(data.linkedProgramId, 100), linkedClassId } });
        await syncOfferingSessionDates(tx, { offeringId: created.id, linkedClassId, instructorId, dates: sessionDates });
        return tx.specialProgramOffering.findUniqueOrThrow({ where: { id: created.id }, include: { sessionDates: { orderBy: { startsAt: "asc" } } } });
      });
      await prisma.specialProgramAuditLog.create({ data: { seasonId, offeringId: offering.id, actorType: "ADMIN", actorId: actor.appUserId, action: "OFFERING_CREATED", afterJSON: offering } });
      return NextResponse.json({ offering }, { status: 201 });
    }
    throw new SeasonalError("지원하지 않는 생성 대상입니다.");
  } catch (error) { return respondError(error); }
}

async function manualRetrySeasonalSms(input: {
  trigger: SeasonalSmsTrigger; applicationId: string; itemId?: string | null; recipientPhone: string;
  recipientUserId?: string | null; variables: Record<string, string>; deliveryRunId: string;
}) {
  const eventId = deliveryEventId(input.applicationId, input.itemId, input.trigger);
  const reservation = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${eventId}))`;
    await expireStaleSmsDeliveries(tx);
    const rows = await tx.$queryRawUnsafe<Array<{ status: string; updatedAt: Date; errorCode: string | null }>>(
      `SELECT status, "updatedAt", "errorCode" FROM "NotificationDelivery"
        WHERE "eventType" = 'SPECIAL_PROGRAM_NOTIFICATION' AND "payloadJSON"->>'eventId' = $1
        ORDER BY "updatedAt" DESC LIMIT 1`,
      eventId,
    );
    const latest = rows[0];
    if (latest) {
      if (latest.errorCode === "FAILED_DELIVERY_UNCERTAIN") {
        throw new SeasonalError("이전 문자 발송 결과를 확정할 수 없어 운영 확인이 필요합니다.", 409, "NOTIFICATION_DELIVERY_UNCERTAIN");
      }
      const ageMs = Date.now() - new Date(latest.updatedAt).getTime();
      if ((latest.status === "PENDING" || latest.status === "SENDING") && ageMs < 15 * 60_000) {
        throw new SeasonalError("이미 발송이 진행 중입니다.", 409, "NOTIFICATION_PENDING");
      }
      if (ageMs < 3_000) throw new SeasonalError("같은 알림을 방금 재발송했습니다.", 409, "NOTIFICATION_RETRY_COOLDOWN");
    }
    return reserveSeasonalParentSms(tx, {
      trigger: input.trigger, applicationId: input.applicationId, itemId: input.itemId,
      recipientPhone: input.recipientPhone, recipientUserId: input.recipientUserId, deliveryRunId: input.deliveryRunId,
    });
  });
  if (reservation.status !== "PENDING" || !reservation.deliveryId) return reservation;
  return dispatchSeasonalParentSms({
    deliveryId: reservation.deliveryId, trigger: input.trigger, recipientPhone: input.recipientPhone, variables: input.variables,
  });
}

async function retryActivationSeasonalSms(input: {
  applicationId: string; itemId: string; invoiceId: string; parentId: string; recipientPhone: string;
  variables: Record<string, string>; deliveryRunId: string;
}) {
  const trigger = SEASONAL_SMS_TRIGGERS.accountActivation;
  const eventId = deliveryEventId(input.applicationId, input.itemId, trigger);
  const prepared = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${eventId}))`;
    await expireStaleSmsDeliveries(tx);
    const rows = await tx.$queryRawUnsafe<Array<{ status: string; updatedAt: Date; errorCode: string | null }>>(
      `SELECT status, "updatedAt", "errorCode" FROM "NotificationDelivery"
        WHERE "eventType" = 'SPECIAL_PROGRAM_NOTIFICATION' AND "payloadJSON"->>'eventId' = $1
        ORDER BY "updatedAt" DESC LIMIT 1`, eventId,
    );
    const latest = rows[0];
    if (latest?.errorCode === "FAILED_DELIVERY_UNCERTAIN") throw new SeasonalError("이전 문자 발송 결과를 확정할 수 없어 운영 확인이 필요합니다.", 409, "NOTIFICATION_DELIVERY_UNCERTAIN");
    if (latest) {
      const ageMs = Date.now() - new Date(latest.updatedAt).getTime();
      if ((latest.status === "PENDING" || latest.status === "SENDING") && ageMs < 15 * 60_000) throw new SeasonalError("이미 발송이 진행 중입니다.", 409, "NOTIFICATION_PENDING");
      if (ageMs < 3_000) throw new SeasonalError("같은 알림을 방금 재발송했습니다.", 409, "NOTIFICATION_RETRY_COOLDOWN");
    }
    const activation = await issueParentAccountClaim({
      parentId: input.parentId, applicationId: input.applicationId, invoiceId: input.invoiceId,
      redirectPath: `/payments/${encodeURIComponent(input.invoiceId)}`, enforceCooldown: false,
    }, tx);
    if (!activation.activationRequired || !activation.activationUrl) throw new SeasonalError("활성화 링크를 발급할 수 없는 보호자 계정입니다.", 409, "ACCOUNT_ALREADY_ACTIVE");
    const reservation = await reserveSeasonalParentSms(tx, {
      trigger, applicationId: input.applicationId, itemId: input.itemId, recipientPhone: input.recipientPhone,
      recipientUserId: input.parentId, deliveryRunId: input.deliveryRunId,
    });
    if (reservation.status !== "PENDING" || !reservation.deliveryId) throw new SeasonalError("활성화 안내 발송을 예약하지 못했습니다.", 503, "ACTIVATION_REISSUE_REQUIRED");
    return { activationUrl: activation.activationUrl, deliveryId: reservation.deliveryId };
  });
  const notification = await dispatchSeasonalParentSms({
    deliveryId: prepared.deliveryId, trigger, recipientPhone: input.recipientPhone,
    variables: { ...input.variables, activationUrl: publicUrl(prepared.activationUrl) },
  });
  return { notification, activationUrl: prepared.activationUrl, activationRequired: true as const };
}

async function retrySeasonalNotification(params: { id: string; scope: string; trigger: SeasonalSmsTrigger; idempotencyKey?: string }) {
  const deliveryRunId = params.idempotencyKey || randomUUID();
  if (params.scope === "application") {
    const allowed = new Set<SeasonalSmsTrigger>([
      SEASONAL_SMS_TRIGGERS.received, SEASONAL_SMS_TRIGGERS.approved, SEASONAL_SMS_TRIGGERS.waitlisted,
      SEASONAL_SMS_TRIGGERS.rejected, SEASONAL_SMS_TRIGGERS.cancelled,
    ]);
    if (!allowed.has(params.trigger)) throw new SeasonalError("신청서에서 재발송할 수 없는 알림입니다.", 400, "INVALID_NOTIFICATION_TRIGGER");
    const application = await prisma.specialProgramApplication.findUnique({
      where: { id: params.id },
      include: { season: { select: { title: true } }, items: { include: { offering: { select: { title: true } } } } },
    });
    if (application) {
      const expectedTrigger: SeasonalSmsTrigger | undefined = application.status === "PENDING" ? SEASONAL_SMS_TRIGGERS.received
        : application.status === "PARTIALLY_WAITLISTED" ? SEASONAL_SMS_TRIGGERS.waitlisted
        : ITEM_NOTIFICATION_TRIGGER[application.status];
      if (params.trigger !== SEASONAL_SMS_TRIGGERS.received && params.trigger !== expectedTrigger) {
        throw new SeasonalError("현재 신청 상태와 알림 종류가 일치하지 않습니다.", 409, "NOTIFICATION_STATE_MISMATCH");
      }
    }
    if (!application) throw new SeasonalError("신청서를 찾을 수 없습니다.", 404, "APPLICATION_NOT_FOUND");
    return manualRetrySeasonalSms({
      trigger: params.trigger, applicationId: application.id, recipientPhone: application.parentPhone,
      variables: { childName: application.childName, parentName: application.parentName, seasonTitle: application.season.title,
        offeringTitle: application.items.map((item) => item.offering.title).join(", "), waitlistOrder: "" },
      deliveryRunId,
    });
  }
  const item = await prisma.specialProgramApplicationItem.findUnique({
    where: { id: params.id }, include: { application: true, offering: { include: { season: true } } },
  });
  if (!item) throw new SeasonalError("신청 항목을 찾을 수 없습니다.", 404, "APPLICATION_ITEM_NOT_FOUND");
  if (params.scope === "item") {
    if (ITEM_NOTIFICATION_TRIGGER[item.status] !== params.trigger) throw new SeasonalError("현재 신청 항목 상태와 알림 종류가 일치하지 않습니다.", 409, "NOTIFICATION_STATE_MISMATCH");
    if (!Object.values(ITEM_NOTIFICATION_TRIGGER).includes(params.trigger)) throw new SeasonalError("신청 항목에서 재발송할 수 없는 알림입니다.", 400, "INVALID_NOTIFICATION_TRIGGER");
    return manualRetrySeasonalSms({
      trigger: params.trigger, applicationId: item.applicationId, itemId: item.id, recipientPhone: item.application.parentPhone,
      variables: { childName: item.application.childName, parentName: item.application.parentName, seasonTitle: item.offering.season.title,
        offeringTitle: item.offering.title, waitlistOrder: item.waitlistOrder ? String(item.waitlistOrder) : "" }, deliveryRunId,
    });
  }
  if (params.scope !== "invoice") throw new SeasonalError("알림 재발송 범위가 올바르지 않습니다.", 400, "INVALID_NOTIFICATION_SCOPE");
  if (!item.paymentId) throw new SeasonalError("청구서를 찾을 수 없습니다.", 404, "INVOICE_NOT_FOUND");
  const validationInvoice = await prisma.paymentInvoice.findUnique({ where: { paymentId: item.paymentId } });
  if (!validationInvoice) throw new SeasonalError("청구서를 찾을 수 없습니다.", 404, "INVOICE_NOT_FOUND");
  const invoiceParent = validationInvoice.parentId
    ? await prisma.user.findUnique({ where: { id: validationInvoice.parentId }, select: { email: true } })
    : null;
  // 빈 보호자 계정 판정은 공용 규칙 한 곳(parent-synthetic-email.ts)을 쓴다
  const activationRequired = Boolean(invoiceParent && isSyntheticParentEmail(invoiceParent.email));
  const expectedInvoiceTrigger = activationRequired ? SEASONAL_SMS_TRIGGERS.accountActivation : SEASONAL_SMS_TRIGGERS.paymentRequest;
  if (params.trigger !== expectedInvoiceTrigger) throw new SeasonalError("현재 보호자 계정 상태와 알림 종류가 일치하지 않습니다.", 409, "NOTIFICATION_STATE_MISMATCH");
  if (params.trigger === SEASONAL_SMS_TRIGGERS.accountActivation) {
    if (!validationInvoice.parentId) throw new SeasonalError("보호자 계정을 찾을 수 없습니다.", 404, "PARENT_NOT_FOUND");
    const retried = await retryActivationSeasonalSms({
      applicationId: item.applicationId, itemId: item.id, invoiceId: validationInvoice.id,
      parentId: validationInvoice.parentId, recipientPhone: item.application.parentPhone,
      variables: { childName: item.application.childName, parentName: item.application.parentName,
        seasonTitle: item.offering.season.title, offeringTitle: item.offering.title }, deliveryRunId,
    });
    return retried.notification;
  }
  if (params.trigger !== SEASONAL_SMS_TRIGGERS.paymentRequest || !item.paymentId) throw new SeasonalError("청구서에서 재발송할 수 없는 알림입니다.", 400, "INVALID_NOTIFICATION_TRIGGER");
  const invoice = await prisma.paymentInvoice.findUnique({ where: { paymentId: item.paymentId } });
  if (!invoice) throw new SeasonalError("청구서를 찾을 수 없습니다.", 404, "INVOICE_NOT_FOUND");
  return manualRetrySeasonalSms({
    trigger: params.trigger, applicationId: item.applicationId, itemId: item.id, recipientPhone: item.application.parentPhone,
    recipientUserId: invoice.parentId,
    variables: { childName: item.application.childName, parentName: item.application.parentName, seasonTitle: item.offering.season.title,
      offeringTitle: item.offering.title, paymentUrl: publicUrl(`/payments/${encodeURIComponent(invoice.id)}`), amount: String(invoice.amount),
      dueDate: invoice.dueDate.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }) }, deliveryRunId,
  });
}

export async function PATCH(request: NextRequest) {
  try {
    const actor = await admin();
    const body = await request.json();
    const data = body?.data || {};
    if (body.resource === "bulkItems") {
      const status = cleanText(data.status, 30);
      if (!status || !ITEM_STATUSES.has(status)) throw new SeasonalError("일괄 처리 상태가 올바르지 않습니다.");
      const itemIds = parseBulkItemIds(data.itemIds);
      if (itemIds.length === 0) throw new SeasonalError("선택된 신청 항목이 없습니다.");
      if (itemIds.length > 100) throw new SeasonalError("한 번에 100개까지만 처리할 수 있습니다.", 413, "BULK_LIMIT_EXCEEDED");

      const results: BulkItemResult[] = [];
      for (const itemId of itemIds) {
        try {
          const changed = await prisma.$transaction(
            (tx) => updateSpecialProgramItemStatus(tx, { itemId, status, actorId: actor.appUserId }),
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
          // 승인 확정 후(트랜잭션 커밋 뒤) 날짜별 출석 슬롯을 채운다. 실패해도 승인은 유지된다.
          if (changed.item.status === "APPROVED") await syncEnrollmentDatesForItemSafe(itemId);
          // 취소·반려 등 승인 해제 시 그 항목의 좌석을 소프트취소 → 출석부·명단에서 제거(출결 찍힌 좌석은 보존).
          else if (changed.changed) await cancelEnrollmentDatesForItemSafe(itemId);
          const notification = await notifyItemStatus(changed);
          results.push({
            itemId,
            ok: true,
            status: changed.item.status,
            applicationId: changed.item.applicationId,
            ...(notification ? { notification, notificationWarning: notificationNeedsWarning(notification) } : {}),
          });
        } catch (error) {
          results.push(bulkErrorResult(itemId, error));
        }
      }

      const summary = {
        total: results.length,
        succeeded: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length,
        notificationsFailed: results.filter((result) => result.notificationWarning).length,
      };
      return NextResponse.json({ success: summary.failed === 0, summary, results });
    }

    if (body.resource === "bulkConversion") {
      const itemIds = parseBulkItemIds(data.itemIds);
      if (itemIds.length === 0) throw new SeasonalError("선택된 신청 항목이 없습니다.");
      if (itemIds.length > 50) throw new SeasonalError("수강·청구 생성은 한 번에 50개까지만 처리할 수 있습니다.", 413, "BULK_CONVERSION_LIMIT_EXCEEDED");

      const results: BulkItemResult[] = [];
      for (const itemId of itemIds) {
        try {
          const result = await convertApprovedItemToEnrollmentAndInvoice(itemId, actor.appUserId);
          results.push({
            itemId,
            ok: true,
            invoiceId: result.invoiceId,
            activationRequired: result.activationRequired,
            notification: result.notification,
            notificationWarning: result.notificationWarning,
          });
        } catch (error) {
          results.push(bulkErrorResult(itemId, error));
        }
      }

      const summary = {
        total: results.length,
        succeeded: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length,
        notificationsFailed: results.filter((result) => result.notificationWarning).length,
      };
      return NextResponse.json({ success: summary.failed === 0, summary, results });
    }

    const id = cleanText(body?.id, 100);
    if (!id) throw new SeasonalError("수정 대상 ID가 필요합니다.");

    if (body.resource === "season") {
      const before = await prisma.specialProgramSeason.findUnique({ where: { id } });
      if (!before) throw new SeasonalError("시즌을 찾을 수 없습니다.", 404);
      const update: Record<string, unknown> = {};
      if (data.title !== undefined) update.title = cleanText(data.title, 150);
      if (data.description !== undefined) update.description = cleanText(data.description, 5000) || null;
      if (data.status !== undefined) { if (!SEASON_STATUSES.has(data.status)) throw new SeasonalError("시즌 상태가 올바르지 않습니다."); update.status = data.status; }
      for (const key of ["applicationOpensAt", "applicationClosesAt", "startsAt", "endsAt"] as const) if (data[key] !== undefined) update[key] = date(data[key], key);
      if (data.termsText !== undefined) update.termsText = cleanText(data.termsText, 10000) || null;
      if (data.cancellationPolicy !== undefined) update.cancellationPolicy = cleanText(data.cancellationPolicy, 10000) || null;
      const season = await prisma.specialProgramSeason.update({ where: { id }, data: update });
      await prisma.specialProgramAuditLog.create({ data: { seasonId: id, actorType: "ADMIN", actorId: actor.appUserId, action: "SEASON_UPDATED", beforeJSON: before, afterJSON: season } });
      return NextResponse.json({ season });
    }

    if (body.resource === "offeringInstructor") {
      const instructorId = cleanText(data.instructorId, 100) || null;
      const instructorName = instructorId ? cleanText(data.instructorName, 100) || null : null;
      const result = await prisma.$transaction(
        (tx) => updateOperationalOfferingInstructor(tx, { offeringId: id, instructorId, instructorName, actorId: actor.appUserId }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return NextResponse.json(result);
    }

    if (body.resource === "operationalSlotInstructor") {
      const instructorId = cleanText(data.instructorId, 100) || null;
      const instructorName = instructorId ? cleanText(data.instructorName, 100) || null : null;
      const weekday = cleanText(data.weekday, 10) || "";
      const result = await prisma.$transaction(
        (tx) => updateOperationalSlotInstructor(tx, { offeringId: id, weekday, instructorId, instructorName, actorId: actor.appUserId }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return NextResponse.json(result);
    }

    if (body.resource === "offering") {
      const before = await prisma.specialProgramOffering.findUnique({ where: { id } });
      if (!before) throw new SeasonalError("특강을 찾을 수 없습니다.", 404);
      const update: Record<string, unknown> = {};
      if (data.code !== undefined) {
        const code = cleanText(data.code, 80)?.toUpperCase();
        if (!code) throw new SeasonalError("반 코드를 입력해 주세요.");
        update.code = code;
      }
      for (const key of ["title", "description", "targetGrades", "instructorId", "instructorName", "location", "linkedProgramId", "linkedClassId"] as const) if (data[key] !== undefined) update[key] = cleanText(data[key], key === "description" ? 5000 : 200) || null;
      if (data.capacity !== undefined) update.capacity = optionalNonNegativeInt(data.capacity, "정원");
      if (data.price !== undefined) update.price = nonNegativeInt(data.price, "가격");
      if (data.newApplicantPrice !== undefined) update.newApplicantPrice = optionalNonNegativeInt(data.newApplicantPrice, "신규 회원 가격");
      if (data.existingApplicantPrice !== undefined) update.existingApplicantPrice = optionalNonNegativeInt(data.existingApplicantPrice, "기존 회원 가격");
      if (data.shuttleFee !== undefined) update.shuttleFee = nonNegativeInt(data.shuttleFee, "셔틀비");
      if (data.status !== undefined) { if (!OFFERING_STATUSES.has(data.status)) throw new SeasonalError("특강 상태가 올바르지 않습니다."); update.status = data.status; }
      const nextStatus = (update.status as string | undefined) ?? before.status;
      const nextCapacity = (update.capacity === undefined ? before.capacity : update.capacity) as number | null;
      const nextLinkedClassId = (update.linkedClassId === undefined ? before.linkedClassId : update.linkedClassId) as string | null;
      const nextInstructorId = (update.instructorId === undefined ? before.instructorId : update.instructorId) as string | null;
      if (nextStatus === "OPEN" && nextCapacity === null) throw new SeasonalError("정원이 정해지지 않은 반은 공개할 수 없습니다.", 409, "CAPACITY_REQUIRED");
      if (data.shuttleAvailable !== undefined) update.shuttleAvailable = Boolean(data.shuttleAvailable);
      if (data.displayOrder !== undefined) update.displayOrder = Number(data.displayOrder) || 0;
      const replacementDates = Array.isArray(data.sessionDates)
        ? (data.sessionDates as SessionDateInput[]).map((row) => ({
            id: cleanText(row.id, 100) || null,
            startsAt: date(row.startsAt, "수업 시작 시각"),
            endsAt: date(row.endsAt, "수업 종료 시각"),
            location: cleanText(row.location, 150),
            note: cleanText(row.note, 500),
          }))
        : null;
      if (replacementDates?.some((row: { startsAt: Date; endsAt: Date }) => row.endsAt <= row.startsAt)) throw new SeasonalError("수업 종료 시각은 시작 시각보다 늦어야 합니다.");
      if (nextStatus === "OPEN") {
        const sessionDateCount = replacementDates?.length ?? await prisma.specialProgramSessionDate.count({ where: { offeringId: id } });
        if (sessionDateCount === 0) throw new SeasonalError("모집 중인 반은 수업 일정을 한 개 이상 등록해야 합니다.", 409, "SESSION_DATE_REQUIRED");
      }
      const offering = await prisma.$transaction(async (tx) => {
        const updated = await tx.specialProgramOffering.update({ where: { id }, data: update });
        if (replacementDates || data.linkedClassId !== undefined || data.instructorId !== undefined) {
          const dates = replacementDates ?? await tx.specialProgramSessionDate.findMany({
            where: { offeringId: id },
            orderBy: { startsAt: "asc" },
            select: { id: true, startsAt: true, endsAt: true, location: true, note: true },
          });
          await syncOfferingSessionDates(tx, { offeringId: id, linkedClassId: nextLinkedClassId, instructorId: nextInstructorId, dates });
        }
        return tx.specialProgramOffering.findUniqueOrThrow({ where: { id: updated.id }, include: { sessionDates: { orderBy: { startsAt: "asc" } } } });
      });
      await prisma.specialProgramAuditLog.create({ data: { seasonId: offering.seasonId, offeringId: id, actorType: "ADMIN", actorId: actor.appUserId, action: "OFFERING_UPDATED", beforeJSON: before, afterJSON: offering } });
      return NextResponse.json({ offering });
    }

    if (body.resource === "notificationRetry") {
      const scope = cleanText(data.scope, 30);
      const trigger = cleanText(data.trigger, 100);
      if (!scope || !trigger || !Object.values(SEASONAL_SMS_TRIGGERS).includes(trigger as SeasonalSmsTrigger)) {
        throw new SeasonalError("재발송할 알림 정보를 확인해 주세요.", 400, "INVALID_NOTIFICATION_RETRY");
      }
      const result = await retrySeasonalNotification({
        id, scope, trigger: trigger as SeasonalSmsTrigger, idempotencyKey: cleanText(data.idempotencyKey, 100),
      });
      return NextResponse.json({
        success: true,
        notification: notificationSummary(result, trigger as SeasonalSmsTrigger),
        ...(notificationNeedsWarning(result) ? { notificationWarning: true } : {}),
      });
    }

    if (body.resource === "applicationReview") {
      if (data.action !== "CLEAR") throw new SeasonalError("검토 완료 동작을 확인해 주세요.");
      const reviewNote = cleanText(data.reviewNote, 1000);
      if (!reviewNote) throw new SeasonalError("검토한 근거를 메모로 남겨 주세요.", 400, "REVIEW_NOTE_REQUIRED");
      const before = await prisma.specialProgramApplication.findUnique({ where: { id } });
      if (!before) throw new SeasonalError("신청서를 찾을 수 없습니다.", 404);
      const application = await prisma.$transaction(async (tx) => {
        const updated = await tx.specialProgramApplication.update({
          where: { id },
          data: { requiresReview: false, reviewReasons: [], processedAt: new Date(), processedByUserId: actor.appUserId, processedNote: reviewNote },
        });
        await tx.specialProgramAuditLog.create({
          data: {
            seasonId: updated.seasonId,
            applicationId: id,
            actorType: "ADMIN",
            actorId: actor.appUserId,
            action: "APPLICATION_REVIEW_CLEARED",
            beforeJSON: { requiresReview: before.requiresReview, reviewReasons: before.reviewReasons },
            afterJSON: { requiresReview: false, reviewReasons: [], reviewNote },
          },
        });
        return updated;
      });
      return NextResponse.json({ application });
    }

    if (body.resource === "application") {
      if (!APPLICATION_STATUSES.has(data.status)) throw new SeasonalError("신청 상태가 올바르지 않습니다.");
      const before = await prisma.specialProgramApplication.findUnique({ where: { id } });
      if (!before) throw new SeasonalError("신청서를 찾을 수 없습니다.", 404);
      if (data.status === "APPROVED" && (before.requiresReview || before.reviewReasons.length > 0)) {
        throw new SeasonalError("검토 필요 사유를 먼저 확인하고 검토 완료 처리해 주세요.", 409, "APPLICATION_REVIEW_REQUIRED");
      }
      const applicationChange = await prisma.$transaction(async (tx) => {
        if (data.status === "APPROVED") await ensureApplicationCapacity(tx, id);
        const closesApplication = data.status === "CANCELLED" || data.status === "REJECTED";
        const updated = await tx.specialProgramApplication.update({
          where: { id },
          data: {
            status: data.status,
            processedAt: new Date(),
            processedByUserId: actor.appUserId,
            processedNote: cleanText(data.processedNote, 1000),
            ...(closesApplication ? { requiresReview: false, reviewReasons: [] } : {}),
          },
        });
        if (before.status !== updated.status) {
          await tx.specialProgramAuditLog.create({ data: { seasonId: updated.seasonId, applicationId: id, actorType: "ADMIN", actorId: actor.appUserId, action: "APPLICATION_STATUS_UPDATED", beforeJSON: before, afterJSON: updated } });
        }
        const trigger = before.status === updated.status ? null : ITEM_NOTIFICATION_TRIGGER[updated.status];
        const reservation = trigger ? await reserveSeasonalParentSms(tx, {
          trigger,
          applicationId: updated.id,
          recipientPhone: updated.parentPhone,
        }) : null;
        return { updated, trigger, reservation };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      const application = applicationChange.updated;
      const notification = applicationChange.trigger && applicationChange.reservation?.status === "PENDING" && applicationChange.reservation.deliveryId
        ? await dispatchSeasonalParentSms({
        deliveryId: applicationChange.reservation.deliveryId,
        trigger: applicationChange.trigger,
        recipientPhone: application.parentPhone,
        variables: { childName: application.childName, parentName: application.parentName, seasonTitle: "", offeringTitle: "", waitlistOrder: "" },
      }) : applicationChange.reservation;
      return NextResponse.json({ application, notification, ...(notificationNeedsWarning(notification) ? { notificationWarning: true } : {}) });
    }

    if (body.resource === "itemAssignment" || body.resource === "applicationAssignment") {
      const offeringId = cleanText(data.offeringId, 100);
      if (!offeringId) throw new SeasonalError("배정할 특강 반을 선택해 주세요.", 400, "OFFERING_REQUIRED");
      const selectedWeekdays = normalizeSelectedWeekdays(data.selectedWeekdays);
      if (selectedWeekdays.length === 0) throw new SeasonalError("학생이 실제 참여할 요일을 선택해 주세요.", 400, "WEEKDAYS_REQUIRED");
      const priceSnapshot = nonNegativeInt(data.priceSnapshot, "금액");
      if (priceSnapshot <= 0) throw new SeasonalError("금액은 1원 이상이어야 합니다.", 400, "PRICE_REQUIRED");
      const result = await prisma.$transaction(
        (tx) => body.resource === "itemAssignment"
          ? saveSpecialProgramItemAssignment(tx, { itemId: id, offeringId, selectedWeekdays, priceSnapshot, actorId: actor.appUserId })
          : createSpecialProgramApplicationItem(tx, { applicationId: id, offeringId, selectedWeekdays, priceSnapshot, actorId: actor.appUserId }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      // 반 이동·요일 변경 확정 후(트랜잭션 커밋 뒤) 출석 슬롯을 새 반·새 요일에 맞춰 다시 맞춘다.
      // 신청서 단위로 처리해야 형제 항목 슬롯이 낡지 않는다. 실패해도 반 이동은 그대로 유지된다.
      const enrollmentDatesResync = await resyncEnrollmentDatesForApplicationSafe(result.item.applicationId);
      if (enrollmentDatesResync && enrollmentDatesResync.blockedByAttendance > 0) {
        // 출결이 찍혀 예전 반에 남긴 좌석이 있으면 감사로그로 남긴다(이동 자체는 막지 않는다).
        try {
          await prisma.specialProgramAuditLog.create({
            data: {
              seasonId: result.application.seasonId,
              offeringId: result.item.offeringId,
              applicationId: result.item.applicationId,
              itemId: result.item.id,
              actorType: "ADMIN",
              actorId: actor.appUserId,
              action: "ITEM_ASSIGNMENT_UPDATED",
              afterJSON: {
                enrollmentDatesResync: {
                  inserted: enrollmentDatesResync.inserted,
                  cancelled: enrollmentDatesResync.cancelled,
                  revived: enrollmentDatesResync.revived,
                  blockedByAttendance: enrollmentDatesResync.blockedByAttendance,
                },
              },
            },
          });
        } catch (error) {
          console.error("[admin seasonal] 재동기화 감사로그 기록 실패", error);
        }
      }
      return NextResponse.json({ ...result, enrollmentDatesResync });
    }

    if (body.resource === "item") {
      const status = cleanText(data.status, 30);
      if (!status || !ITEM_STATUSES.has(status)) throw new SeasonalError("신청 항목 상태가 올바르지 않습니다.");
      const changed = await prisma.$transaction(
        (tx) => updateSpecialProgramItemStatus(tx, { itemId: id, status, actorId: actor.appUserId, enrollmentId: data.enrollmentId, paymentId: data.paymentId }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      // 승인 확정 후(트랜잭션 커밋 뒤) 날짜별 출석 슬롯을 채운다. 실패해도 승인은 유지된다.
      if (changed.item.status === "APPROVED") await syncEnrollmentDatesForItemSafe(id);
      // 취소·반려 등 승인 해제 시 그 항목의 좌석을 소프트취소 → 출석부·명단에서 제거(출결 찍힌 좌석은 보존).
      else if (changed.changed) await cancelEnrollmentDatesForItemSafe(id);
      const notification = await notifyItemStatus(changed);
      return NextResponse.json({
        item: changed.item,
        notification,
        ...(notificationNeedsWarning(notification) ? { notificationWarning: true } : {}),
      });
    }

    if (body.resource === "conversion") {
      const result = await convertApprovedItemToEnrollmentAndInvoice(id, actor.appUserId);
      return NextResponse.json({ success: true, ...result });
    }

    if (body.resource === "accountActivation") {
      if (data.action !== "reissue") throw new SeasonalError("지원하지 않는 계정 활성화 작업입니다.");
      const activationTarget = await accountClaimTargetForItem(id);
      const prepared = await retryActivationSeasonalSms({
        applicationId: activationTarget.applicationId, itemId: id, invoiceId: activationTarget.invoiceId,
        parentId: activationTarget.parentId, recipientPhone: activationTarget.parentPhone,
        variables: { childName: activationTarget.childName, parentName: activationTarget.parentName,
          seasonTitle: activationTarget.seasonTitle, offeringTitle: activationTarget.offeringTitle },
        deliveryRunId: randomUUID(),
      });
      const auditTarget = await prisma.specialProgramApplicationItem.findUnique({
        where: { id },
        select: { applicationId: true, offeringId: true, application: { select: { seasonId: true } } },
      });
      if (auditTarget) {
        await prisma.specialProgramAuditLog.create({
          data: {
            seasonId: auditTarget.application.seasonId,
            offeringId: auditTarget.offeringId,
            applicationId: auditTarget.applicationId,
            itemId: id,
            actorType: "ADMIN",
            actorId: actor.appUserId,
            action: "PARENT_ACCOUNT_ACTIVATION_REISSUED",
            afterJSON: { activationRequired: true },
          },
        });
      }
      return NextResponse.json({ success: true, activationRequired: true, activationUrl: prepared.activationUrl,
        notification: prepared.notification, ...(notificationNeedsWarning(prepared.notification) ? { notificationWarning: true } : {}) });
    }
    if (body.resource === "markPaid") {
      const method = (data as { method?: unknown })?.method === "CASH" ? "CASH" : "BANK_TRANSFER";
      const rows = await prisma.$queryRawUnsafe<{ paymentId: string | null; invoiceId: string | null; amount: number | null }[]>(
        `SELECT "paymentId", pi.id AS "invoiceId", pi.amount
           FROM "SpecialProgramApplicationItem" ai
           LEFT JOIN "Payment" p ON p.id = ai."paymentId"
           LEFT JOIN "PaymentInvoice" pi ON pi."paymentId" = p.id
          WHERE ai.id = $1 LIMIT 1`,
        id,
      );
      const row = rows[0];
      if (!row?.paymentId) throw new SeasonalError("연결된 청구서가 없습니다. 먼저 청구서를 생성하세요.");
      const updated = await prisma.$executeRawUnsafe(
        `UPDATE "Payment" SET status='PAID', method=$2, "paidDate"=NOW(), "paidProvider"='MANUAL', "updatedAt"=NOW()
          WHERE id=$1 AND status NOT IN ('PAID','COMPLETED')`,
        row.paymentId, method,
      );
      if (!updated) throw new SeasonalError("이미 납부 완료 처리된 청구서입니다.");
      if (row.invoiceId) {
        await prisma.$executeRawUnsafe(
          `UPDATE "PaymentInvoice" SET status='PAID', "paidDate"=NOW(), "updatedAt"=NOW() WHERE id=$1`,
          row.invoiceId,
        );
      }
      return NextResponse.json({ ok: true });
    }
    throw new SeasonalError("지원하지 않는 수정 대상입니다.");
  } catch (error) { return respondError(error); }
}

async function convertApprovedItemToEnrollmentAndInvoice(itemId: string, actorId: string): Promise<ConversionResult> {
  await ensurePaymentInfrastructure();

  const converted = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SpecialProgramApplicationItem" WHERE id = ${itemId} FOR UPDATE`;
    const item = await tx.specialProgramApplicationItem.findUnique({
      where: { id: itemId },
      include: {
        application: true,
        offering: { include: { season: true } },
      },
    });
    if (!item) throw new SeasonalError("신청 항목을 찾을 수 없습니다.", 404);
    if (item.status !== "APPROVED") throw new SeasonalError("승인된 신청 항목만 수강·청구로 전환할 수 있습니다.", 409, "ITEM_NOT_APPROVED");
    if (item.application.requiresReview || item.application.reviewReasons.length > 0) {
      throw new SeasonalError("검토 필요 사유를 먼저 확인하고 검토 완료 처리해 주세요.", 409, "APPLICATION_REVIEW_REQUIRED");
    }
    const linkedClassId = item.offering.linkedClassId || null;

    const parentPhone = normalizeDigits(item.application.parentPhone);
    if (parentPhone.length < 10) throw new SeasonalError("보호자 연락처를 확인해 주세요.");
    const parentName = item.application.parentName || "학부모";
    const parentEmail = `parent_${parentPhone}@stiz.local`;

    const existingParents = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "User"
       WHERE role = 'PARENT'
         AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ${parentPhone}
       LIMIT 1
    `;
    let parentId = existingParents[0]?.id;
    let matchedGuardianStudentId: string | null = null;
    if (!parentId) {
      const guardianMatches = await tx.$queryRaw<Array<{ studentId: string }>>`
        SELECT DISTINCT student.id AS "studentId"
          FROM "Student" student
          JOIN "Guardian" guardian ON guardian."studentId" = student.id
         -- 병합으로 흡수된 중복 학생에 신청서가 다시 붙지 않도록 대표만 본다.
         WHERE student."mergedIntoStudentId" IS NULL
           AND student.name = ${item.application.childName}
           AND ((student."birthDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')::date = (${item.application.childBirthDate}::timestamptz AT TIME ZONE 'Asia/Seoul')::date
           AND regexp_replace(COALESCE(guardian.phone, ''), '[^0-9]', '', 'g') = ${parentPhone}
         ORDER BY student.id
         LIMIT 2
      `;
      if (guardianMatches.length > 1) {
        throw new SeasonalError("같은 학생 정보와 보호자 연락처가 여러 건이라 관리자 확인이 필요합니다.", 409, "GUARDIAN_MATCH_AMBIGUOUS");
      }
      if (guardianMatches[0]) {
        matchedGuardianStudentId = guardianMatches[0].studentId;
      }
    }
    if (!parentId) {
      const parents = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "User" (id, email, name, phone, role, "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, ${parentEmail}, ${parentName}, ${parentPhone}, 'PARENT', NOW(), NOW())
        ON CONFLICT (email) DO UPDATE SET
          name = COALESCE("User".name, EXCLUDED.name),
          phone = COALESCE("User".phone, EXCLUDED.phone),
          "updatedAt" = NOW()
        RETURNING id
      `;
      parentId = parents[0]?.id;
    }
    if (!parentId) throw new SeasonalError("학부모 계정을 준비하지 못했습니다.", 500, "PARENT_SAVE_FAILED");

    const existingStudents = matchedGuardianStudentId ? [] : await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Student"
       WHERE "mergedIntoStudentId" IS NULL
         AND name = ${item.application.childName}
         AND "parentId" = ${parentId}
         AND (("birthDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')::date = (${item.application.childBirthDate}::timestamptz AT TIME ZONE 'Asia/Seoul')::date
       LIMIT 1
    `;
    let studentId = matchedGuardianStudentId ?? existingStudents[0]?.id;
    if (studentId) {
      await tx.$executeRaw`
        UPDATE "Student" SET
          gender = COALESCE(${item.application.childGender}, gender),
          grade = COALESCE(${item.application.childGrade}, grade),
          school = COALESCE(${item.application.childSchool}, school),
          phone = COALESCE(${item.application.childPhone}, phone),
          address = COALESCE(${item.application.address}, address),
          "updatedAt" = NOW()
        WHERE id = ${studentId}
      `;
    } else {
      const students = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "Student" (
          id, name, "birthDate", gender, grade, school, phone, address,
          "parentId", "enrollDate", "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid()::text, ${item.application.childName}, ${item.application.childBirthDate},
          ${item.application.childGender}, ${item.application.childGrade}, ${item.application.childSchool},
          ${item.application.childPhone}, ${item.application.address}, ${parentId}, NOW(), NOW(), NOW()
        )
        RETURNING id
      `;
      studentId = students[0]?.id;
    }
    if (!studentId) throw new SeasonalError("학생 정보를 준비하지 못했습니다.", 500, "STUDENT_SAVE_FAILED");

    const relation = item.application.parentRelation || "보호자";
    const guardianRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Guardian"
       WHERE "studentId" = ${studentId}
         AND COALESCE(phone, '') = ${parentPhone}
       LIMIT 1
    `;
    if (guardianRows.length === 0) {
      await tx.$executeRaw`
        INSERT INTO "Guardian" (id, "studentId", relation, name, phone, "isPrimary", "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, ${studentId}, ${relation}, ${parentName}, ${parentPhone}, true, NOW(), NOW())
      `;
    }

    let enrollmentId = item.enrollmentId || null;
    if (linkedClassId) {
      const enrollments = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "Enrollment" (id, "studentId", "classId", status, "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, ${studentId}, ${linkedClassId}, 'ACTIVE', NOW(), NOW())
        ON CONFLICT ("studentId", "classId") DO UPDATE SET status = 'ACTIVE', "updatedAt" = NOW()
        RETURNING id
      `;
      enrollmentId = enrollmentId || enrollments[0]?.id || null;
      if (!enrollmentId) throw new SeasonalError("수강 등록을 준비하지 못했습니다.", 500, "ENROLLMENT_SAVE_FAILED");
    }

    let paymentId = item.paymentId || null;
    if (paymentId) {
      const payments = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Payment" WHERE id = ${paymentId} LIMIT 1`;
      if (payments.length === 0) paymentId = null;
    }
    if (!paymentId) {
      const dueDate = defaultPaymentDueDate();
      const year = dueDate.getFullYear();
      const month = dueDate.getMonth() + 1;
      const description = `${item.offering.season.title} · ${item.titleSnapshot}`;
      const payments = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "Payment" (
          id, "studentId", "classId", amount, status, "dueDate",
          type, method, description, month, year, "autoGenerated", "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid()::text, ${studentId}, ${linkedClassId}, ${item.priceSnapshot}, 'PENDING', ${dueDate},
          'SPECIAL', 'UNPAID', ${description}, ${month}, ${year}, false, NOW(), NOW()
        )
        RETURNING id
      `;
      paymentId = payments[0]?.id || null;
    }
    if (!paymentId) throw new SeasonalError("청구 정보를 준비하지 못했습니다.", 500, "PAYMENT_SAVE_FAILED");

    const updated = await tx.specialProgramApplicationItem.update({
      where: { id: item.id },
      data: { enrollmentId, paymentId, conversionStatus: "INVOICE_PENDING", conversionError: null },
    });
    await tx.specialProgramApplication.update({
      where: { id: item.applicationId },
      data: { convertedStudentId: studentId, processedAt: new Date(), processedByUserId: actorId },
    });
    await tx.specialProgramAuditLog.create({
      data: {
        seasonId: item.application.seasonId,
        offeringId: item.offeringId,
        applicationId: item.applicationId,
        itemId: item.id,
        actorType: "ADMIN",
        actorId,
        action: "ITEM_CONVERTED_TO_ENROLLMENT_PAYMENT",
        afterJSON: { studentId, enrollmentId, paymentId, linkedClassId },
      },
    });

    return {
      itemId: updated.id,
      studentId,
      enrollmentId,
      paymentId,
      parentId,
      applicationId: item.applicationId,
      parentPhone: item.application.parentPhone,
      parentName: item.application.parentName,
      childName: item.application.childName,
      seasonTitle: item.offering.season.title,
      offeringTitle: item.offering.title,
      amount: item.priceSnapshot,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  let invoice: Awaited<ReturnType<typeof ensureInvoiceForPayment>>;
  try {
    invoice = await ensureInvoiceForPayment(converted.paymentId);
    if (!invoice) throw new Error("INVOICE_NOT_CREATED");
  } catch (error) {
    await prisma.specialProgramApplicationItem.update({
      where: { id: converted.itemId },
      data: { conversionStatus: "INVOICE_RETRY_REQUIRED", conversionError: "INVOICE_CREATION_FAILED" },
    });
    await prisma.specialProgramAuditLog.create({
      data: {
        itemId: converted.itemId,
        actorType: "ADMIN",
        actorId,
        action: "INVOICE_CREATION_FAILED",
        afterJSON: { paymentId: converted.paymentId, retryable: true },
      },
    });
    console.error("[admin seasonal invoice]", error);
    throw new SeasonalError("수강 등록과 결제 정보는 저장됐지만 청구서 생성에 실패했습니다. 다시 시도해 주세요.", 503, "INVOICE_RETRY_REQUIRED");
  }

  const recoveryParent = await prisma.user.findUnique({ where: { id: converted.parentId }, select: { email: true } });
  const activationRequiredOnRecovery = Boolean(recoveryParent && isSyntheticParentEmail(recoveryParent.email));
  const prepared = await prisma.$transaction(async (tx) => {
    const activation = await issueParentAccountClaim({
      parentId: converted.parentId, applicationId: converted.applicationId, invoiceId: invoice.id,
      redirectPath: `/payments/${encodeURIComponent(invoice.id)}`,
    }, tx);
    if (activation.activationRequired && !activation.activationUrl) {
      throw new SeasonalError("계정 활성화 링크를 준비하지 못했습니다. 다시 시도해 주세요.", 503, "ACTIVATION_REISSUE_REQUIRED");
    }
    const trigger = activation.activationRequired ? SEASONAL_SMS_TRIGGERS.accountActivation : SEASONAL_SMS_TRIGGERS.paymentRequest;
    const reservation = await reserveSeasonalParentSms(tx, {
      trigger, applicationId: converted.applicationId, itemId: converted.itemId,
      recipientPhone: converted.parentPhone, recipientUserId: converted.parentId,
    });
    if (reservation.status !== "PENDING" || !reservation.deliveryId) {
      throw new SeasonalError("문자 발송을 예약하지 못했습니다. 알림 재발송이 필요합니다.", 503, "NOTIFICATION_RESERVATION_FAILED");
    }
    await tx.specialProgramApplicationItem.update({
      where: { id: converted.itemId }, data: { conversionStatus: "COMPLETED", conversionError: null },
    });
    return { activation, trigger, reservation };
  }).catch(async (error) => {
    if (!(error instanceof SeasonalError) || error.code !== "NOTIFICATION_RESERVATION_FAILED") throw error;
    await prisma.specialProgramApplicationItem.update({
      where: { id: converted.itemId }, data: { conversionStatus: "COMPLETED", conversionError: "NOTIFICATION_RETRY_REQUIRED" },
    });
    return null;
  });
  if (!prepared) {
    return {
      itemId: converted.itemId, studentId: converted.studentId, enrollmentId: converted.enrollmentId,
      paymentId: converted.paymentId, invoiceId: invoice.id, activationRequired: activationRequiredOnRecovery,
      notification: { ok: false, status: "FAILED", deliveryId: null, errorCode: "NOTIFICATION_RESERVATION_FAILED",
        ...(activationRequiredOnRecovery ? { requiresReissue: true } : {}) },
      notificationWarning: true,
    };
  }
  const { activation, trigger, reservation } = prepared;
  const notification = reservation.status === "PENDING" && reservation.deliveryId ? await dispatchSeasonalParentSms({
    deliveryId: reservation.deliveryId,
    trigger,
    recipientPhone: converted.parentPhone,
    variables: {
      childName: converted.childName,
      parentName: converted.parentName,
      seasonTitle: converted.seasonTitle,
      offeringTitle: converted.offeringTitle,
      activationUrl: activation.activationRequired ? publicUrl(activation.activationUrl!) : "",
      paymentUrl: activation.activationRequired ? "" : publicUrl(`/payments/${encodeURIComponent(invoice.id)}`),
      amount: String(converted.amount),
      dueDate: new Date(String(invoice.dueDate)).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }),
    },
  }) : reservation;
  return {
    itemId: converted.itemId,
    studentId: converted.studentId,
    enrollmentId: converted.enrollmentId,
    paymentId: converted.paymentId,
    invoiceId: invoice.id,
    activationRequired: activation.activationRequired,
    notification,
    ...(notificationNeedsWarning(notification) ? { notificationWarning: true as const } : {}),
  };
}

async function accountClaimTargetForItem(itemId: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ parentId: string; applicationId: string; invoiceId: string; parentPhone: string; parentName: string; childName: string; seasonTitle: string; offeringTitle: string }>>(
    `SELECT i."parentId", item."applicationId", i.id AS "invoiceId",
            app."parentPhone", app."parentName", app."childName", season.title AS "seasonTitle", offering.title AS "offeringTitle"
       FROM "SpecialProgramApplicationItem" item
       JOIN "PaymentInvoice" i ON i."paymentId" = item."paymentId"
       JOIN "SpecialProgramApplication" app ON app.id = item."applicationId"
       JOIN "SpecialProgramOffering" offering ON offering.id = item."offeringId"
       JOIN "SpecialProgramSeason" season ON season.id = offering."seasonId"
      WHERE item.id = $1 LIMIT 1`,
    itemId,
  );
  const target = rows[0];
  if (!target) throw new SeasonalError("계정 활성화 대상 청구서를 찾을 수 없습니다.", 404, "ACCOUNT_CLAIM_TARGET_NOT_FOUND");
  return target;
}

export async function DELETE(request: NextRequest) {
  try {
    const actor = await admin();
    const resource = request.nextUrl.searchParams.get("resource");
    const id = request.nextUrl.searchParams.get("id");
    if (!id || (resource !== "season" && resource !== "offering")) throw new SeasonalError("삭제 대상이 올바르지 않습니다.");
    if (resource === "offering") {
      const offering = await prisma.specialProgramOffering.findUnique({ where: { id }, include: { _count: { select: { applicationItems: true } } } });
      if (!offering) throw new SeasonalError("특강을 찾을 수 없습니다.", 404);
      if (offering._count.applicationItems > 0) throw new SeasonalError("신청 이력이 있는 특강은 삭제 대신 취소 처리해 주세요.", 409);
      const protectedSessions = await prisma.session.count({
        where: {
          specialProgramSessionDate: { offeringId: id },
          OR: [{ status: { not: "PLANNED" } }, { attendances: { some: {} } }],
        },
      });
      if (protectedSessions > 0) throw new SeasonalError("이미 시작했거나 출석 기록이 있는 특강은 삭제 대신 취소 처리해 주세요.", 409, "SEASONAL_SESSION_PROTECTED");
      await prisma.$transaction(async (tx) => {
        await tx.specialProgramAuditLog.create({ data: { seasonId: offering.seasonId, offeringId: id, actorType: "ADMIN", actorId: actor.appUserId, action: "OFFERING_DELETED", beforeJSON: offering } });
        await tx.session.deleteMany({ where: { specialProgramSessionDate: { offeringId: id } } });
        await tx.specialProgramOffering.delete({ where: { id } });
      });
      return NextResponse.json({ success: true });
    }
    const season = await prisma.specialProgramSeason.findUnique({ where: { id }, include: { _count: { select: { applications: true } } } });
    if (!season) throw new SeasonalError("시즌을 찾을 수 없습니다.", 404);
    if (season._count.applications > 0) throw new SeasonalError("신청 이력이 있는 시즌은 삭제 대신 보관 처리해 주세요.", 409);
    const protectedSessions = await prisma.session.count({
      where: {
        specialProgramSessionDate: { offering: { seasonId: id } },
        OR: [{ status: { not: "PLANNED" } }, { attendances: { some: {} } }],
      },
    });
    if (protectedSessions > 0) throw new SeasonalError("이미 시작했거나 출석 기록이 있는 특강 시즌은 삭제 대신 보관 처리해 주세요.", 409, "SEASONAL_SESSION_PROTECTED");
    await prisma.$transaction(async (tx) => {
      await tx.specialProgramAuditLog.create({ data: { seasonId: id, actorType: "ADMIN", actorId: actor.appUserId, action: "SEASON_DELETED", beforeJSON: season } });
      await tx.session.deleteMany({ where: { specialProgramSessionDate: { offering: { seasonId: id } } } });
      await tx.specialProgramSeason.delete({ where: { id } });
    });
    return NextResponse.json({ success: true });
  } catch (error) { return respondError(error); }
}
