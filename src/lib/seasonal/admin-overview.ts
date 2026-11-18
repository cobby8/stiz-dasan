import { prisma } from "@/lib/prisma";

export type SeasonalAdminStats = {
  pending: number;
  confirmed: number;
  unpaid: number;
  waitlisted: number;
  shuttleUnassigned: number;
};

type SeasonalWeekdayCountRow = {
  seasonId: string;
  groupKey: string;
  weekday: string;
  confirmed: number | string | null;
  held: number | string | null;
  waitlisted: number | string | null;
};

type SeasonalGroupTotalRow = {
  seasonId: string;
  groupKey: string;
  confirmedTotal: number | string | null;
  heldTotal: number | string | null;
  waitlistedTotal: number | string | null;
  dateSelectedTotal: number | string | null;
};

type OperationalStats = {
  confirmedTotal: number;
  heldTotal: number;
  waitlistedTotal: number;
  /** 날짜별 선택으로 신청한(승인 대기·승인) 항목 수 — 요일 집계엔 고른 날짜의 요일로 함께 잡힌다(2026-11-18). */
  dateSelectedTotal: number;
  weekdays: Record<string, { confirmed: number; held: number; waitlisted: number }>;
};

export async function getSeasonalAdminStats(): Promise<SeasonalAdminStats> {
  const rows = await prisma.$queryRawUnsafe<Array<{
    pending: number | string | null;
    confirmed: number | string | null;
    unpaid: number | string | null;
    waitlisted: number | string | null;
    shuttleUnassigned: number | string | null;
  }>>(
    `SELECT
        COUNT(DISTINCT app.id) FILTER (WHERE item.status = 'PENDING')::int AS pending,
        COUNT(DISTINCT app.id) FILTER (WHERE item.status = 'APPROVED')::int AS confirmed,
        COUNT(DISTINCT app.id) FILTER (
          WHERE item.status = 'APPROVED'
            AND NOT (payment.status IN ('PAID','COMPLETED') OR invoice.status IN ('PAID','COMPLETED'))
        )::int AS unpaid,
        COUNT(DISTINCT app.id) FILTER (WHERE item.status = 'WAITLISTED' OR app.status = 'PARTIALLY_WAITLISTED')::int AS waitlisted,
        COUNT(DISTINCT app.id) FILTER (
          WHERE shuttle.id IS NOT NULL
            AND (shuttle."assignedRouteId" IS NULL OR shuttle."assignedStopId" IS NULL)
        )::int AS "shuttleUnassigned"
       FROM "SpecialProgramApplication" app
       LEFT JOIN "SpecialProgramApplicationItem" item ON item."applicationId" = app.id
       LEFT JOIN "Payment" payment ON payment.id = item."paymentId"
       LEFT JOIN "PaymentInvoice" invoice ON invoice."paymentId" = item."paymentId"
       LEFT JOIN "SpecialProgramShuttleRequest" shuttle ON shuttle."applicationItemId" = item.id`,
  );
  const row = rows[0] ?? {};

  return {
    pending: Number(row.pending ?? 0),
    confirmed: Number(row.confirmed ?? 0),
    unpaid: Number(row.unpaid ?? 0),
    waitlisted: Number(row.waitlisted ?? 0),
    shuttleUnassigned: Number(row.shuttleUnassigned ?? 0),
  };
}

export async function getSeasonalAdminOverview(seasonId?: string) {
  const [seasons, stats] = await Promise.all([
    prisma.specialProgramSeason.findMany({
      where: seasonId ? { id: seasonId } : undefined,
      orderBy: { startsAt: "desc" },
      include: {
        offerings: {
          orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
          include: {
            sessionDates: {
              orderBy: { startsAt: "asc" },
              include: { session: { select: { coachId: true } } },
            },
            // 반별 «기간별 수강료»(2026-11-18) — 관리자 반 편집·배정 화면이 쓴다
            periods: { orderBy: [{ displayOrder: "asc" }, { startDate: "asc" }, { endDate: "asc" }] },
            _count: { select: { applicationItems: true } },
          },
        },
      },
    }),
    getSeasonalAdminStats(),
  ]);
  const seasonIds = seasons.map((season) => season.id);
  const [countRows, totalRows] = seasonIds.length
    ? await Promise.all([
        prisma.$queryRawUnsafe<SeasonalWeekdayCountRow[]>(
          `SELECT app."seasonId",
                  COALESCE(offering."linkedClassId", offering.id) AS "groupKey",
                  selected.day_key AS weekday,
                  COUNT(DISTINCT item.id) FILTER (WHERE item.status = 'APPROVED')::int AS confirmed,
                  COUNT(DISTINCT item.id) FILTER (WHERE item.status IN ('PENDING','APPROVED'))::int AS held,
                  COUNT(DISTINCT item.id) FILTER (WHERE item.status = 'WAITLISTED')::int AS waitlisted
             FROM "SpecialProgramApplicationItem" item
             JOIN "SpecialProgramApplication" app ON app.id = item."applicationId"
             JOIN "SpecialProgramOffering" offering ON offering.id = item."offeringId"
             JOIN LATERAL unnest(app."selectedWeekdays") AS selected(day_key) ON TRUE
            WHERE app."seasonId" = ANY($1::text[])
            GROUP BY app."seasonId", COALESCE(offering."linkedClassId", offering.id), selected.day_key`,
          seasonIds,
        ),
        prisma.$queryRawUnsafe<SeasonalGroupTotalRow[]>(
          `SELECT app."seasonId",
                  COALESCE(offering."linkedClassId", offering.id) AS "groupKey",
                  COUNT(DISTINCT item.id) FILTER (WHERE item.status = 'APPROVED')::int AS "confirmedTotal",
                  COUNT(DISTINCT item.id) FILTER (WHERE item.status IN ('PENDING','APPROVED'))::int AS "heldTotal",
                  COUNT(DISTINCT item.id) FILTER (WHERE item.status = 'WAITLISTED')::int AS "waitlistedTotal",
                  -- 날짜별 선택 신청(고른 날짜가 있는 신청서) 중 자리를 차지한 항목 수
                  COUNT(DISTINCT item.id) FILTER (
                    WHERE item.status IN ('PENDING','APPROVED') AND COALESCE(cardinality(app."selectedDates"), 0) > 0
                  )::int AS "dateSelectedTotal"
             FROM "SpecialProgramApplicationItem" item
             JOIN "SpecialProgramApplication" app ON app.id = item."applicationId"
             JOIN "SpecialProgramOffering" offering ON offering.id = item."offeringId"
            WHERE app."seasonId" = ANY($1::text[])
            GROUP BY app."seasonId", COALESCE(offering."linkedClassId", offering.id)`,
          seasonIds,
        ),
      ])
    : [[], []];
  const statsByGroup = new Map<string, OperationalStats>();
  for (const row of totalRows) {
    statsByGroup.set(`${row.seasonId}:${row.groupKey}`, {
      confirmedTotal: Number(row.confirmedTotal ?? 0),
      heldTotal: Number(row.heldTotal ?? 0),
      waitlistedTotal: Number(row.waitlistedTotal ?? 0),
      dateSelectedTotal: Number(row.dateSelectedTotal ?? 0),
      weekdays: {},
    });
  }
  for (const row of countRows) {
    const mapKey = `${row.seasonId}:${row.groupKey}`;
    const current = statsByGroup.get(mapKey) ?? { confirmedTotal: 0, heldTotal: 0, waitlistedTotal: 0, dateSelectedTotal: 0, weekdays: {} };
    const confirmed = Number(row.confirmed ?? 0);
    const held = Number(row.held ?? 0);
    const waitlisted = Number(row.waitlisted ?? 0);
    current.weekdays[row.weekday] = { confirmed, held, waitlisted };
    statsByGroup.set(mapKey, current);
  }
  const enrichedSeasons = seasons.map((season) => ({
    ...season,
    offerings: season.offerings.map((offering) => ({
      ...offering,
      operationalStats: statsByGroup.get(`${season.id}:${offering.linkedClassId || offering.id}`) ?? {
        confirmedTotal: 0,
        heldTotal: 0,
        waitlistedTotal: 0,
        dateSelectedTotal: 0,
        weekdays: {},
      },
    })),
  }));

  return { seasons: enrichedSeasons, applications: [], stats };
}
