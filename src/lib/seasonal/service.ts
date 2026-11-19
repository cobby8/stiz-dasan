import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  SEASONAL_SMS_TRIGGERS,
  dispatchSeasonalParentSms,
  reserveSeasonalParentSms,
  type SeasonalSmsDeliveryResult,
} from "@/lib/seasonal/notifications";
import { notifyAdmins } from "@/lib/notification";
import { prisma } from "@/lib/prisma";
import { SeasonalError, assertWeekdayCountMatchesFrequency, type SeasonalApplicationInput, type SeasonalWeekday } from "./contracts";
import { decideApplicantType, hasSeasonalShuttleSelection, isFreeHubShuttle, resolveOfferingPrice, resolveShuttleFee, totalSnapshot, weekdayInSeoul } from "./planning";
import { getSettings } from "./shuttle-optimize";
import { syncSeasonSiblingDiscounts } from "./sibling-discount-sync";
// 공개 응답의 남은 자리는 3단계(여유/임박/마감)로만(재원생 수 비공개 · 2026-11-13 f9)
import { seatLevel } from "@/lib/seats/seatLevel";
// 기간 선택·날짜별 선택(2026-11-18) — 출석 규칙·가격·판단은 공용 부품 한 곳에서만
import { kstHm, kstLabel, todayKst, toKstYmd } from "@/lib/datetime/kst";
import { countOccupancyByDate, type SeasonalAttendanceRule } from "./attendance-rule";
import {
  countActivePeriods,
  hasPeriodMix,
  isPeriodClosed,
  periodClosedError,
  periodMixedOfferingsError,
  proratedPrice,
  resolvePeriodPrice,
  resolvePeriodShuttleFee,
  usesPeriodOrDateFeatures,
  offeringWeeklyFrequency,
} from "./period-pricing";
import { offeringTitleWithFrequency } from "./offering-groups";
import {
  activePeriods,
  assertDateCount,
  assertDatesInPeriod,
  assertPeriodHasWeekdays,
  assertSelectableDates,
  firstSelectableYmd,
  fullDateKeysFromOccupancy,
  hasLateJoinDates,
  itemTitleSnapshot,
  periodEndedError,
  pickOfferingPeriod,
  requiredDateCount,
  weekdaysFromDates,
} from "./application-plan";
import { findFullDates } from "./date-capacity";

const OCCUPYING_ITEM_STATUSES = ["PENDING", "APPROVED"];
const ACTIVE_APPLICATION_ITEM_STATUSES = ["PENDING", "APPROVED", "WAITLISTED"];
type PublicOfferingRow = Prisma.SpecialProgramOfferingGetPayload<{
  include: { sessionDates: true; periods: true; _count: { select: { applicationItems: true } } };
}>;
type PublicSeasonRow = Prisma.SpecialProgramSeasonGetPayload<{
  include: { offerings: { include: { sessionDates: true; periods: true; _count: { select: { applicationItems: true } } } } };
}>;
type AssignmentOffering = Prisma.SpecialProgramOfferingGetPayload<{
  include: { sessionDates: { select: { id: true; startsAt: true } }; periods: true };
}>;
type AssignmentSeason = {
  dateSelectEnabled: boolean;
};
// 신청 배정 조회에 함께 싣는 «회차·기간» 포함 설정(잠금 뒤 조회·범위 후보 조회가 같은 모양이어야 한다)
const ASSIGNMENT_INCLUDE = {
  sessionDates: { select: { id: true, startsAt: true } },
  periods: true,
} as const;

function publicStatus(season: { status: string; applicationOpensAt: Date; applicationClosesAt: Date; endsAt: Date }) {
  const now = new Date();
  if (season.status !== "PUBLISHED" || now > season.endsAt) return "ENDED";
  if (now < season.applicationOpensAt) return "UPCOMING";
  if (now > season.applicationClosesAt) return "CLOSED";
  return "OPEN";
}

// 반 이름 «주N회» 또는 코드 끝 «-N» — 화면·관리자와 같은 함수 하나(2026-11-19 반 이름에서 횟수를 빼도 코드로 안다)
function seasonalOfferingFrequency(offering: Pick<AssignmentOffering, "title" | "code">) {
  return offeringWeeklyFrequency(offering);
}

function offeringScopeWhere(offering: Pick<AssignmentOffering, "id" | "seasonId" | "linkedClassId">) {
  return offering.linkedClassId
    ? { seasonId: offering.seasonId, linkedClassId: offering.linkedClassId }
    : { id: offering.id };
}

/**
 * 공개 신청이 «같은 운영 묶음»으로 보는 반 조회 조건 = 같은 시즌·같은 연결 반 + 모집 중(OPEN) 반만.
 * 관리자 재배정의 남은 회차 계산도 이 조건 하나를 쓴다(검수 L-1 — 두 곳 회차 범위가 갈라지면 금액이 달라진다).
 * 결과가 비면 두 곳 모두 그 반 하나(대상 반)로 대체한다.
 */
export function openScopeOfferingWhere(offering: Pick<AssignmentOffering, "id" | "seasonId" | "linkedClassId">) {
  return { ...offeringScopeWhere(offering), status: "OPEN" as const };
}

type AssignmentRequest = Pick<SeasonalApplicationInput, "selectionMode" | "selectedDates" | "periodStartDate" | "periodEndDate" | "weeklyFrequency">;

async function resolvePublicOfferingAssignment(
  tx: Prisma.TransactionClient,
  target: AssignmentOffering,
  selectedWeekdays: SeasonalWeekday[],
  applicantType: "NEW" | "EXISTING",
  season: AssignmentSeason,
  request: AssignmentRequest,
  // 시즌 모집 마감이 지났는가 — 날짜 모드는 이때 «중간 합류»로만 받는다
  deadline: { seasonClosed: boolean },
) {
  const candidates = await tx.specialProgramOffering.findMany({
    where: openScopeOfferingWhere(target),
    include: ASSIGNMENT_INCLUDE,
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  });
  const scopeOfferings = candidates.length ? candidates : [target];
  // 새 기능(기간 상품표·날짜별 신청)을 쓰는 범위면 정원을 «날짜별»로 센다. 아니면 기존 요일별 판정 그대로.
  // 판정은 공용 함수 하나(관리자 승인·보강·출석부와 같은 기준) — 꺼진 기간 행(isActive=false)은 세지 않는다.
  const usesDateCapacity = usesPeriodOrDateFeatures({
    dateSelectEnabled: season.dateSelectEnabled,
    activePeriodCount: scopeOfferings.reduce((sum, offering) => sum + countActivePeriods(offering.periods), 0),
  });

  // 날짜 모드(2026-11-18 원장 결정): «기간 → 주N회 → 날짜». 주N회는 화면에서 고른 값,
  //   요일 모드는 고른 요일 수가 곧 N. 반·가격 고르기는 두 모드가 아래 같은 코드를 쓴다(같은 규칙 두 벌 금지).
  const isDateMode = request.selectionMode === "DATE";
  if (isDateMode && !season.dateSelectEnabled) {
    throw new SeasonalError("이 특강은 날짜별 신청을 받지 않습니다.", 400, "DATE_SELECT_DISABLED");
  }
  // 요일 모드: 화면이 «주 몇 회»를 보냈으면 그 값(요일 수와 같아야 함 — 2026-11-19), 안 보냈으면 요일 수(옛 화면 호환)
  if (!isDateMode) assertWeekdayCountMatchesFrequency(selectedWeekdays.length, request.weeklyFrequency);
  const frequency = isDateMode || request.weeklyFrequency != null ? Number(request.weeklyFrequency) : selectedWeekdays.length;

  const frequencyCandidates = candidates.filter((candidate) => seasonalOfferingFrequency(candidate) !== null);
  const offering = frequencyCandidates.length
    ? frequencyCandidates.find((candidate) => seasonalOfferingFrequency(candidate) === frequency)
    : target;
  if (!offering) {
    throw new SeasonalError(
      isDateMode || request.weeklyFrequency != null ? `주${frequency}회 수강료가 설정되지 않았습니다.` : `선택한 ${selectedWeekdays.length}개 요일에 맞는 수강료가 설정되지 않았습니다.`,
      409,
      "OFFERING_FREQUENCY_NOT_CONFIGURED",
    );
  }
  // 그 반에 기간 상품이 있으면 고른 기간의 가격(1개뿐이면 자동 적용, 없으면 409/400)
  const period = pickOfferingPeriod(offering.periods, {
    startDate: request.periodStartDate,
    endDate: request.periodEndDate,
  });
  // 기간별 신청 마감(예: 4주 1/1(금) 18:00) — 마감 시각 그 순간부터 요일 모드(기간 전체 신청)는 받지 않는다.
  //   날짜 모드는 마감 뒤에도 «남은 회차로 중간 합류»를 받는다(2026-11-18 원장) — 아래 날짜 모드 검사에서 판정.
  const periodClosed = Boolean(period && isPeriodClosed(period));
  if (period && periodClosed && !isDateMode) throw periodClosedError(period.label);

  // 수강료는 두 모드가 같은 «정상 수강료» — 기간 가격(없으면 반 가격). 회당 단가는 쓰지 않는다.
  const normalPrice = period ? resolvePeriodPrice(period, applicantType) : resolveOfferingPrice(offering, applicantType);
  // 날짜 모드의 남은 회차 비율(셔틀비도 같은 비율). 요일 모드·시작 전 신청은 null/비율 1 = 정상 금액 그대로.
  let proration: { remainingCount: number; fullCount: number } | null = null;
  const todayYmd = todayKst();
  // 마감(기간 또는 시즌)이 지났으면 중간 합류 — 고를 수 있는 첫 날 = 내일(2026-11-19 원장), 마감 전은 오늘 그대로
  const lateJoin = periodClosed || deadline.seasonClosed;
  const selectableFromYmd = firstSelectableYmd(todayYmd, lateJoin);
  if (isDateMode) {
    const scopeSessionDates = scopeOfferings.flatMap((item) => item.sessionDates);
    // 중간 합류는 마지막 회차 전날까지만(남은 날이 없으면 409 PERIOD_ENDED)
    if (lateJoin && !hasLateJoinDates(scopeSessionDates, todayYmd, period)) {
      throw periodEndedError();
    }
    // 날짜 모드 검사 — 기간 밖 날짜 409, 필요 횟수(고를 수 있는 첫 날부터 남은 회차 기준)와 다르면 400
    assertDatesInPeriod(request.selectedDates, period);
    const fullCount = requiredDateCount(scopeSessionDates, frequency, period);
    const required = requiredDateCount(scopeSessionDates, frequency, period, selectableFromYmd);
    // 회차는 있는데 남은 게 없다 = 이미 끝난 기간(회차 자체가 없으면 아래 assertDateCount 가 DATE_NOT_OFFERED)
    if (fullCount > 0 && required === 0) throw periodEndedError();
    assertDateCount(request.selectedDates.length, required, frequency, period?.label);
    proration = { remainingCount: required, fullCount };
  }
  return {
    offering,
    scopeOfferings,
    // 날짜 모드 = 정상 수강료 × 남은 회차 비율(100원 내림), 요일 모드 = 정상 수강료
    priceSnapshot: proration ? proratedPrice(normalPrice, proration.remainingCount, proration.fullCount) : normalPrice,
    proration,
    period,
    unitPrice: null as number | null,
    // 날짜 모드는 고른 횟수를 남긴다(목록·제목 «날짜 선택 8회»)
    sessionCount: isDateMode ? request.selectedDates.length as number | null : null,
    usesDateCapacity,
    // 날짜 검사(assertSelectableDates)가 쓰는 «고를 수 있는 첫 날» — 중간 합류면 내일
    selectableFromYmd,
  };
}

async function isOperationalOfferingFull(
  tx: Prisma.TransactionClient,
  offering: AssignmentOffering,
  scopeOfferingIds: string[],
  selectedWeekdays: SeasonalWeekday[],
) {
  if (offering.capacity === null) return false;
  for (const weekday of selectedWeekdays) {
    const rows = await tx.$queryRaw<Array<{ occupied: number }>>`
      SELECT COUNT(DISTINCT item.id)::int AS occupied
        FROM "SpecialProgramApplicationItem" item
        JOIN "SpecialProgramApplication" app ON app.id = item."applicationId"
       WHERE item."offeringId" IN (${Prisma.join(scopeOfferingIds)})
         AND item.status IN (${Prisma.join(OCCUPYING_ITEM_STATUSES)})
         AND (
           COALESCE(cardinality(app."selectedWeekdays"), 0) = 0
           OR ${weekday} = ANY(app."selectedWeekdays")
         )
    `;
    if (Number(rows[0]?.occupied ?? 0) >= offering.capacity) return true;
  }
  return false;
}

/**
 * 공개 화면용 «회차 날짜별 마감 여부» — 특강 반 id → 정원이 찬 KST 날짜 집합.
 * 같은 연결 반(주2회·주3회가 한 교실)을 한 범위로 묶어 날짜별로 센다(신청 저장의 날짜별 정원과 같은 규칙).
 * 숫자는 밖으로 내보내지 않는다 — 참/거짓만(재원생 수 비공개).
 */
async function fullDatesByOffering(seasons: PublicSeasonRow[]): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  // 새 기능(기간 상품표·날짜별 신청)을 쓰는 시즌만 센다 — 기존 시즌 화면은 날짜별 마감을 쓰지 않아 조회를 아낀다.
  //   판정은 신청 접수와 같은 공용 함수(꺼진 기간 행은 세지 않는다).
  const usesDates = (season: PublicSeasonRow) => usesPeriodOrDateFeatures({
    dateSelectEnabled: season.dateSelectEnabled,
    activePeriodCount: (season.offerings || []).reduce((sum, offering) => sum + countActivePeriods(offering.periods), 0),
  });
  const offerings = seasons.filter(usesDates).flatMap((season) => (season.offerings || []).map((offering) => ({ season, offering })));
  if (offerings.length === 0) return result;
  const items = await prisma.specialProgramApplicationItem.findMany({
    where: { offeringId: { in: offerings.map(({ offering }) => offering.id) }, status: { in: OCCUPYING_ITEM_STATUSES } },
    select: {
      offeringId: true,
      applicationId: true,
      application: { select: { selectionMode: true, selectedWeekdays: true, selectedDates: true, periodStartDate: true, periodEndDate: true } },
    },
  });
  // 범위 열쇠 = 시즌 + (연결 반 또는 그 반 자신)
  const scopeKey = (seasonId: string, offering: PublicOfferingRow) => `${seasonId}|${offering.linkedClassId || offering.id}`;
  const scopes = new Map<string, PublicOfferingRow[]>();
  for (const { season, offering } of offerings) {
    const key = scopeKey(season.id, offering);
    scopes.set(key, [...(scopes.get(key) ?? []), offering]);
  }
  for (const scopeOfferings of scopes.values()) {
    const ids = new Set(scopeOfferings.map((offering) => offering.id));
    const rules = new Map<string, SeasonalAttendanceRule>();
    for (const item of items) {
      if (ids.has(item.offeringId) && !rules.has(item.applicationId)) rules.set(item.applicationId, item.application);
    }
    const occupancy = countOccupancyByDate([...rules.values()], scopeOfferings.flatMap((offering) => offering.sessionDates));
    for (const offering of scopeOfferings) {
      result.set(offering.id, new Set(fullDateKeysFromOccupancy(occupancy, offering.capacity)));
    }
  }
  return result;
}

function publicOffering(offering: PublicOfferingRow, fullDates: ReadonlySet<string> = new Set()) {
  const orderedSessionDates = [...(offering.sessionDates || [])].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  const first = orderedSessionDates[0];
  const startsAt = first?.startsAt ? new Date(first.startsAt) : null;
  const endsAt = first?.endsAt ? new Date(first.endsAt) : null;
  const enrolled = offering._count?.applicationItems || 0;
  const capacity = offering.capacity;
  // 신청 인원·남은 자리 숫자는 공개 응답에 싣지 않는다 — 3단계만(정원 미확정이면 null = 학원 문의)
  const level = capacity === null ? null : seatLevel(capacity - enrolled);
  const time = (value: Date | null) => value
    ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(value)
    : "";
  return {
    id: offering.id,
    code: offering.code,
    linkedClassId: offering.linkedClassId,
    name: offering.title,
    dayLabel: startsAt ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" }).format(startsAt) : "일정 미정",
    dateLabel: startsAt ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" }).format(startsAt) : undefined,
    startTime: time(startsAt),
    endTime: time(endsAt),
    sessionDates: orderedSessionDates.map((session) => {
      const sessionStartsAt = new Date(session.startsAt);
      const sessionEndsAt = new Date(session.endsAt);
      // 날짜별 신청 화면이 쓰는 KST 날짜 열쇠와 그날 마감 여부(숫자 없이 참/거짓만)
      const dateKey = toKstYmd(sessionStartsAt);
      return {
        dateKey,
        full: fullDates.has(dateKey),
        startsAt: sessionStartsAt.toISOString(),
        endsAt: sessionEndsAt.toISOString(),
        dateLabel: new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" }).format(sessionStartsAt),
        dayLabel: new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" }).format(sessionStartsAt),
        startTime: time(sessionStartsAt),
        endTime: time(sessionEndsAt),
        location: session.location || offering.location || undefined,
      };
    }),
    location: first?.location || offering.location || undefined,
    targetGrade: offering.targetGrades || undefined,
    coachName: offering.instructorName || undefined,
    capacity,
    seatLevel: level,
    price: offering.price,
    newApplicantPrice: offering.newApplicantPrice,
    existingApplicantPrice: offering.existingApplicantPrice,
    shuttleAvailable: offering.shuttleAvailable,
    shuttleFee: offering.shuttleFee,
    waitlistEnabled: capacity !== null,
    // 기간 상품표(켜진 것만, 표시 순서대로) — 비어 있으면 화면은 예전과 똑같다
    periods: activePeriods(offering.periods).map((period) => ({
      label: period.label,
      startDate: period.startDate,
      endDate: period.endDate,
      price: period.price,
      newApplicantPrice: period.newApplicantPrice,
      existingApplicantPrice: period.existingApplicantPrice,
      shuttleFee: period.shuttleFee,
      displayOrder: period.displayOrder,
      // 기간별 신청 마감(2026-11-18) — 시각(ISO)·지금 마감됐는지·표시 문구 «1/1(금) 18:00». 비어 있으면 시즌 마감을 따른다.
      applicationClosesAt: period.applicationClosesAt ? period.applicationClosesAt.toISOString() : null,
      closed: isPeriodClosed(period),
      closesLabel: period.applicationClosesAt ? `${kstLabel(period.applicationClosesAt)} ${kstHm(period.applicationClosesAt)}` : null,
    })),
  };
}

function publicSeason(season: PublicSeasonRow, fullByOffering: ReadonlyMap<string, ReadonlySet<string>> = new Map()) {
  const classes = (season.offerings || []).map((offering) => publicOffering(offering, fullByOffering.get(offering.id)));
  const status = publicStatus(season);
  return {
    id: season.id,
    slug: season.slug,
    title: season.title,
    summary: season.description || undefined,
    // 기존 값(OPEN/CLOSED/ENDED/UPCOMING)은 그대로 — 중간 합류는 아래 lateJoinOpen 으로 따로 알린다
    status,
    // 중간 합류 가능(2026-11-18 원장): 모집은 마감됐지만 날짜 선택이 켜져 있고 남은 수업 날(내일 이후)이 있으면 true.
    //   신청 서버와 같은 함수(hasLateJoinDates)로 판정한다. 날짜 선택이 꺼진 시즌은 언제나 false(지금처럼 마감).
    lateJoinOpen: status === "CLOSED"
      && season.dateSelectEnabled
      && hasLateJoinDates((season.offerings || []).flatMap((offering) => offering.sessionDates || []), todayKst()),
    applicationStart: season.applicationOpensAt.toISOString(),
    applicationEnd: season.applicationClosesAt.toISOString(),
    operationStart: season.startsAt.toISOString(),
    operationEnd: season.endsAt.toISOString(),
    location: classes.find((item: { location?: string }) => item.location)?.location,
    refundPolicy: season.cancellationPolicy || undefined,
    // 날짜별 신청 설정 — enabled=false 면 화면은 «요일로 고르기»만(예전과 같음)
    dateSelect: {
      enabled: season.dateSelectEnabled,
      perSessionNewPrice: season.perSessionNewPrice,
      perSessionExistingPrice: season.perSessionExistingPrice,
      minSessionCount: season.minSessionCount,
    },
    classes,
  };
}

export async function listPublishedSeasons() {
  const seasons = await prisma.specialProgramSeason.findMany({
    where: { status: "PUBLISHED" },
    orderBy: { startsAt: "desc" },
    include: {
      offerings: {
        // 공개 신청은 정원이 확정된 반만 노출해 접수 후 정원 판정이 달라지지 않게 한다.
        where: { status: "OPEN", capacity: { not: null } },
        orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
        include: {
          sessionDates: { orderBy: { startsAt: "asc" } },
          periods: true,
          _count: { select: { applicationItems: { where: { status: { in: OCCUPYING_ITEM_STATUSES } } } } },
        },
      },
    },
  });
  const fullByOffering = await fullDatesByOffering(seasons);
  return seasons.map((season) => publicSeason(season, fullByOffering));
}

export async function getPublishedSeason(slug: string) {
  const season = await prisma.specialProgramSeason.findFirst({
    where: { slug, status: "PUBLISHED" },
    include: {
      offerings: {
        where: { status: "OPEN", capacity: { not: null } },
        orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
        include: {
          sessionDates: { orderBy: { startsAt: "asc" } },
          periods: true,
          _count: { select: { applicationItems: { where: { status: { in: OCCUPYING_ITEM_STATUSES } } } } },
        },
      },
    },
  });
  if (!season) throw new SeasonalError("모집 중인 방학특강을 찾을 수 없습니다.", 404, "SEASON_NOT_FOUND");
  // 무료 탑승 거점(탑승/하차 지점)을 함께 내려 부모 신청 폼에서 "거점 탑승"을 고를 수 있게 한다.
  const [settings, fullByOffering] = await Promise.all([getSettings(), fullDatesByOffering([season])]);
  const toHub = (g: { lat: number; lng: number; name: string } | null) => g ? { name: g.name, lat: g.lat, lng: g.lng } : null;
  return { ...publicSeason(season, fullByOffering), shuttleHub: { pickup: toHub(settings.hub), dropoff: toHub(settings.hubDropoff) } };
}

async function existingApplication(seasonId: string, idempotencyKey: string) {
  return prisma.specialProgramApplication.findUnique({
    where: { seasonId_idempotencyKey: { seasonId, idempotencyKey } },
    include: { items: true },
  });
}

function applicantFingerprint(input: SeasonalApplicationInput) {
  // 이름의 띄어쓰기·대소문자와 전화번호 표기 차이는 같은 신청자로 취급한다.
  const normalizedName = input.child.name.replace(/\s+/g, "").toLocaleLowerCase("ko-KR");
  const birthDate = new Date(input.child.birthDate).toISOString().slice(0, 10);
  const normalizedPhone = input.parent.phone.replace(/[^0-9]/g, "");
  return createHash("sha256").update(`${normalizedName}|${birthDate}|${normalizedPhone}`, "utf8").digest("hex");
}

async function findActiveDuplicate(
  client: Prisma.TransactionClient | typeof prisma,
  offeringIds: string[],
  fingerprint: string,
) {
  return client.specialProgramApplicationItem.findFirst({
    where: {
      offeringId: { in: offeringIds },
      applicantFingerprint: fingerprint,
      status: { in: ACTIVE_APPLICATION_ITEM_STATUSES },
    },
    select: { offeringId: true },
  });
}

function duplicateApplicationError() {
  return new SeasonalError(
    "같은 학생이 이미 신청한 특강이 포함되어 있습니다. 기존 신청 내역을 확인해 주세요.",
    409,
    "DUPLICATE_APPLICATION",
  );
}

/** 재원 판정에 필요한 값만(공개 신청 입력·관리자 화면의 신청서 둘 다 이 모양으로 넘긴다). */
export type ExistingStudentProbe = {
  child: { name: string; birthDate: string };
  parent: { phone: string };
};

// 기존회원 할인은 "지금 학원에 다니는 원생"에게만 적용한다.
// 이름 + 생년월일 + 학부모 연락처가 모두 맞고, 그 위에 현재 유효한 수강 등록까지 있어야 EXISTING으로 본다.
// 공개 신청(가격 정하기)과 관리자 승인 화면(«재원 확인 필요» 경고, 2026-11-18)이 이 함수 하나를 쓴다.
//   정규반을 휴원하고 특강만 들으면 ACTIVE 가 없어 여기서 false — 신규 수강료(원장 11-18 고지 내용과 같다).
export async function hasMatchingExistingStudent(input: ExistingStudentProbe) {
  const birthDate = new Date(input.child.birthDate);
  const rows = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM "Student" student
        JOIN "User" parent ON parent.id = student."parentId"
       -- 병합으로 흡수된 중복 학생은 판정에서 제외한다 (대표 학생 쪽이 같은 조건으로 매칭된다).
       WHERE student."mergedIntoStudentId" IS NULL
         AND student.name = ${input.child.name}
         -- "Student"."birthDate"는 timestamp(naive) 컬럼이다.
         -- 첫 AT TIME ZONE 'UTC'는 naive 값을 UTC 순간으로 "해석"하고, 두 번째가 KST로 "변환"한다.
         -- 시간대 이중 적용이 아니라 정상적인 2단계 변환이므로 절대 단순화하지 말 것.
         -- (저장 형식이 00:00 / 15:00로 섞여 있어도 두 형식 모두 이 식으로 같은 날짜가 나온다.)
         AND ((student."birthDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')::date = (${birthDate}::timestamptz AT TIME ZONE 'Asia/Seoul')::date
         AND (
           regexp_replace(COALESCE(parent.phone, ''), '[^0-9]', '', 'g') = ${input.parent.phone}
           OR EXISTS (
             SELECT 1 FROM "Guardian" guardian
              WHERE guardian."studentId" = student.id
                AND regexp_replace(COALESCE(guardian.phone, ''), '[^0-9]', '', 'g') = ${input.parent.phone}
           )
         )
         -- 현재 정규반에 재원 중인지 확인한다. 휴원(PAUSED)·퇴원(WITHDRAWN)·과거 이력자는 기존회원 할인 대상이 아니다.
         -- 반 이동 시 예전 반 등록이 PAUSED로 남으므로 "학생 단위 ACTIVE 1건 이상"으로 판정한다.
         AND EXISTS (
           SELECT 1
             FROM "Enrollment" enrollment
             JOIN "Class" class ON class.id = enrollment."classId"
            WHERE enrollment."studentId" = student.id
              AND enrollment.status = 'ACTIVE'
              -- 방학특강 승인 전환은 특강 반에도 ACTIVE 등록을 만든다(admin/seasonal route).
              -- 특강만 수강한 학생은 정규반 수강생이 아니므로 할인 대상에서 제외한다.
              -- 주의: 연결 반은 정규반일 수도 있다(관리자 입력 항목이 "연결 정규 반 ID"다).
              -- 그래서 "특강에 연결됨"만으로 제외하면 그 정규반 원생 전원이 할인을 잃는다.
              -- 정규반은 항상 실제 요일(Mon~Sun)을 가지므로, 특강 전용 반(dayOfWeek='Seasonal')이면서
              -- 특강에 연결된 경우에만 제외해 정상 원생의 할인이 사라지지 않도록 한다.
              AND NOT (
                class."dayOfWeek" = 'Seasonal'
                AND EXISTS (
                  SELECT 1 FROM "SpecialProgramOffering" offering
                   WHERE offering."linkedClassId" = class.id
                )
              )
         )
    ) AS exists
  `;
  return rows[0]?.exists === true;
}

function applicationResponse(application: Awaited<ReturnType<typeof existingApplication>>, duplicate: boolean) {
  if (!application) throw new SeasonalError("신청 저장 결과를 확인할 수 없습니다.", 500, "SAVE_FAILED");
  return {
    applicationId: application.id,
    status: application.status,
    totalPriceSnapshot: application.totalPriceSnapshot,
    duplicate,
    items: application.items.map((item) => ({
      offeringId: item.offeringId,
      status: item.status,
      priceSnapshot: item.priceSnapshot,
      tuitionPriceSnapshot: item.tuitionPriceSnapshot,
      // 형제할인은 학부모 화면에서도 "얼마가 왜 빠졌는지" 보이도록 항목별로 함께 내려준다.
      siblingDiscountSnapshot: item.siblingDiscountSnapshot,
      discountReasonSnapshot: item.discountReasonSnapshot,
      shuttleFeeSnapshot: item.shuttleFeeSnapshot,
      waitlistOrder: item.waitlistOrder,
    })),
  };
}

async function notifyAdminsOfNewSeasonalApplication(
  application: NonNullable<Awaited<ReturnType<typeof existingApplication>>>,
  seasonTitle: string,
) {
  const offeringTitle = application.items.map((item) => item.titleSnapshot).join(", ");
  await notifyAdmins(
    "SPECIAL_APPLICATION",
    "새 특강 신청",
    `${application.childName} (${offeringTitle}) - ${application.parentName}`,
    "/admin/seasonal",
    {
      adminTrigger: "SPECIAL_APPLICATION_NEW_ADMIN",
      notifyCoaches: false,
      eventId: `seasonal-application:${application.id}:new-admin`,
      variables: {
        childName: application.childName,
        seasonTitle,
        offeringTitle,
        parentName: application.parentName,
        parentPhone: application.parentPhone,
      },
    },
  );
}

type ReceivedDeliveryRow = { id: string; status: string; errorCode: string | null };

async function recoverReceivedNotification(
  application: NonNullable<Awaited<ReturnType<typeof existingApplication>>>,
  seasonTitle: string,
): Promise<SeasonalSmsDeliveryResult | null> {
  const eventId = `${application.id}:application:${SEASONAL_SMS_TRIGGERS.received}`;
  const deliveries = await prisma.$queryRawUnsafe<ReceivedDeliveryRow[]>(
    `SELECT id, status, "errorCode" FROM "NotificationDelivery"
      WHERE channel = 'SMS' AND "payloadJSON"->>'eventId' = $1
      ORDER BY "createdAt" DESC LIMIT 1`,
    eventId,
  ).catch(() => []);
  const latest = deliveries[0];
  if (!latest || latest.status === "SENT" || latest.status === "SKIPPED" || latest.status === "SENDING") return null;

  let deliveryId: string | null = latest.status === "PENDING" ? latest.id : null;
  if (latest.status === "FAILED" && latest.errorCode !== "FAILED_DELIVERY_UNCERTAIN") {
    // 실패 건은 조건부 갱신에 성공한 요청 하나만 다시 발송하게 해 동시 재시도의 중복 문자를 막는다.
    const recovered = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE "NotificationDelivery"
          SET status = 'PENDING', "errorCode" = NULL, "failedAt" = NULL, "nextAttemptAt" = NOW(), "updatedAt" = NOW()
        WHERE id = $1 AND status = 'FAILED' AND COALESCE("errorCode", '') <> 'FAILED_DELIVERY_UNCERTAIN'
        RETURNING id`,
      latest.id,
    ).catch(() => []);
    deliveryId = recovered[0]?.id ?? null;
  }
  if (!deliveryId) return null;

  return dispatchSeasonalParentSms({
    deliveryId,
    trigger: SEASONAL_SMS_TRIGGERS.received,
    recipientPhone: application.parentPhone,
    variables: {
      childName: application.childName,
      parentName: application.parentName,
      seasonTitle,
      offeringTitle: application.items.map((item) => item.titleSnapshot).join(", "),
      waitlistOrder: application.items.filter((item) => item.waitlistOrder).map((item) => String(item.waitlistOrder)).join(", "),
    },
  });
}

async function duplicateApplicationResponse(
  application: NonNullable<Awaited<ReturnType<typeof existingApplication>>>,
  seasonTitle: string,
) {
  const response = applicationResponse(application, true);
  const [notification] = await Promise.all([
    recoverReceivedNotification(application, seasonTitle),
    notifyAdminsOfNewSeasonalApplication(application, seasonTitle),
  ]);
  return notification
    ? {
        ...response,
        notification,
        ...(notification.status === "FAILED" || notification.errorCode === "TEMPLATE_DISABLED_OR_MISSING"
          ? { notificationWarning: true as const }
          : {}),
      }
    : response;
}

export async function submitSeasonalApplication(slug: string, input: SeasonalApplicationInput, retryCount = 0) {
  const season = await prisma.specialProgramSeason.findUnique({ where: { slug } });
  if (!season || season.status !== "PUBLISHED") throw new SeasonalError("신청할 수 없는 방학특강입니다.", 404, "SEASON_NOT_FOUND");
  const now = new Date();
  // 시즌 모집 마감 뒤에는 «날짜로 고르기 중간 합류»만 받는다(2026-11-18 원장). 모집 시작 전·운영 종료 뒤는 기존처럼 거절.
  //   남은 회차가 있는지는 반·기간을 고른 뒤 resolvePublicOfferingAssignment 에서 본다(없으면 409 PERIOD_ENDED).
  const seasonClosed = now > season.applicationClosesAt;
  const lateJoinAllowed = input.selectionMode === "DATE" && season.dateSelectEnabled && now <= season.endsAt;
  if (now < season.applicationOpensAt || (seasonClosed && !lateJoinAllowed)) {
    throw new SeasonalError("현재는 신청 기간이 아닙니다.", 409, "APPLICATION_CLOSED");
  }

  const duplicate = await existingApplication(season.id, input.idempotencyKey);
  if (duplicate) return duplicateApplicationResponse(duplicate, season.title);
  const fingerprint = applicantFingerprint(input);
  const applicantDecision = decideApplicantType(input.applicantType, await hasMatchingExistingStudent(input));

  try {
    const committed = await prisma.$transaction(async (tx) => {
      const ids = input.items.map((item) => item.offeringId);

      // 같은 상품을 동시에 신청할 때 정원 계산이 엇갈리지 않도록 행 잠금을 잡는다.
      await tx.$queryRaw`SELECT id FROM "SpecialProgramOffering" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
      const offerings = await tx.specialProgramOffering.findMany({
        where: { id: { in: ids }, seasonId: season.id },
        include: ASSIGNMENT_INCLUDE,
      });
      if (offerings.length !== ids.length || offerings.some((offering) => offering.status !== "OPEN")) {
        throw new SeasonalError("마감되었거나 존재하지 않는 특강이 포함되어 있습니다.", 409, "OFFERING_UNAVAILABLE");
      }
      const offeringById = new Map(offerings.map((offering) => [offering.id, offering]));
      const isDateMode = input.selectionMode === "DATE";
      // 안전장치: 날짜 모드도 요일을 «고른 날짜들의 요일»로 채운다.
      // 비워 두면 요일만 보는 옛 조회(셔틀·출석 일부)가 «요일 없음 = 매일 출석»으로 읽는다.
      const effectiveWeekdays = isDateMode ? weekdaysFromDates(input.selectedDates) : input.selectedWeekdays;
      // 기간 있는 반과 없는 반을 한 신청서에 함께 고르면 «가격 없음»이 아니라 «섞임»으로 안내한다(검수 L-1).
      // 기간 행이 하나도 없는 기존 시즌은 모든 반이 «없음»이라 여기 걸리지 않는다.
      if (!isDateMode && hasPeriodMix(input.items.map((item) => (
        countActivePeriods(offeringById.get(item.offeringId)?.periods) > 0 ? "HAS_PERIOD" : null
      )))) {
        throw periodMixedOfferingsError();
      }
      const assignments: Array<Awaited<ReturnType<typeof resolvePublicOfferingAssignment>>> = [];
      for (const requested of input.items) {
        const offering = offeringById.get(requested.offeringId);
        if (!offering) throw new SeasonalError("신청한 특강 정보를 확인해 주세요.", 400, "OFFERING_ASSIGNMENT_MISSING");
        assignments.push(await resolvePublicOfferingAssignment(tx, offering, effectiveWeekdays, applicantDecision.pricingType, season, input, { seasonClosed }));
      }
      // 신청서에는 기간을 하나만 적을 수 있다 — 항목마다 다른 기간이 나오거나(자동 적용 포함)
      // 기간 있는 반·없는 반이 섞이면 출석 범위와 수강료가 어긋나므로 받지 않는다.
      // 이 경우는 가격이 없는 게 아니라 «섞인 것»이므로 전용 안내(PERIOD_MIXED_OFFERINGS)를 쓴다.
      if (hasPeriodMix(assignments.map((assignment) => assignment.period ? `${assignment.period.startDate}|${assignment.period.endDate}` : null))) {
        throw periodMixedOfferingsError();
      }
      const appliedPeriod = assignments[0]?.period ?? null;
      // 이 신청서가 어느 회차에 나오는가 — 정원 판정·저장이 같은 규칙을 쓴다(attendance-rule.ts)
      const attendanceRule: SeasonalAttendanceRule = {
        selectionMode: input.selectionMode,
        selectedWeekdays: effectiveWeekdays,
        selectedDates: isDateMode ? input.selectedDates : [],
        periodStartDate: appliedPeriod?.startDate ?? null,
        periodEndDate: appliedPeriod?.endDate ?? null,
      };
      const scopedOfferingIds = Array.from(new Set(assignments.flatMap((assignment) => assignment.scopeOfferings.map((offering) => offering.id))));
      if (scopedOfferingIds.length > ids.length) {
        await tx.$queryRaw`SELECT id FROM "SpecialProgramOffering" WHERE id IN (${Prisma.join(scopedOfferingIds)}) ORDER BY id FOR UPDATE`;
      }

      // 특강 행 잠금 안에서 확인하므로 같은 운영 반으로 동시에 들어온 요청도 순서대로 판정된다.
      if (await findActiveDuplicate(tx, scopedOfferingIds, fingerprint)) throw duplicateApplicationError();
      const availableWeekdays = new Set(assignments.flatMap((assignment) =>
        assignment.scopeOfferings.flatMap((offering) => offering.sessionDates.map((session) => weekdayInSeoul(session.startsAt))),
      ));
      // 날짜 모드는 아래 «실제 회차 날짜인가» 검사가 더 정확한 안내를 하므로 요일 검사는 요일 모드만
      const invalidWeekdays = isDateMode ? [] : effectiveWeekdays.filter((weekday) => !availableWeekdays.has(weekday));
      if (invalidWeekdays.length > 0) {
        throw new SeasonalError("선택한 요일과 실제 특강 일정이 일치하지 않습니다.", 409, "WEEKDAY_NOT_OFFERED");
      }
      for (const assignment of assignments) {
        const scopeSessionDates = assignment.scopeOfferings.flatMap((offering) => offering.sessionDates);
        if (isDateMode) {
          // 날짜 모드: 고른 날짜가 그 반 범위의 실제 회차이고 오늘(KST) 이전이 아닌지
          // 마감 뒤 중간 합류면 오늘 날짜도 안 된다(내일 수업부터 · 2026-11-19 원장)
          assertSelectableDates(input.selectedDates, scopeSessionDates, todayKst(), assignment.selectableFromYmd);
        } else if (assignment.period) {
          // 요일 + 기간: 그 기간 안에 고른 요일 회차가 있는지
          assertPeriodHasWeekdays(scopeSessionDates, effectiveWeekdays, assignment.period);
        }
      }

      const waitlistMax = await tx.specialProgramApplicationItem.groupBy({
        by: ["offeringId"],
        where: { offeringId: { in: scopedOfferingIds }, status: "WAITLISTED" },
        _max: { waitlistOrder: true },
      });
      const maxOrders = new Map(waitlistMax.map((row) => [row.offeringId, row._max.waitlistOrder || 0]));
      const itemPlans = [];
      for (let index = 0; index < input.items.length; index += 1) {
        const assignment = assignments[index];
        if (!assignment) throw new SeasonalError("신청할 특강 반 정보를 확인해 주세요.", 400, "OFFERING_ASSIGNMENT_MISSING");
        const scopeOfferingIds = assignment.scopeOfferings.map((offering) => offering.id);
        let full: boolean;
        if (assignment.usesDateCapacity) {
          // 새 기능을 쓰는 범위: 이번 신청이 차지할 날짜마다 정원을 본다(관리자 승인과 같은 함수)
          const fullDates = await findFullDates(tx, {
            scopeOfferingIds,
            capacity: assignment.offering.capacity,
            sessionDates: assignment.scopeOfferings.flatMap((offering) => offering.sessionDates),
            rule: attendanceRule,
          });
          // 찬 날짜가 하나라도 있으면 요일 모드와 똑같이 «대기»로 접수한다(2026-11-18 원장 «정원 마감 시 대기로 받아줘»).
          //   예전엔 날짜 모드만 409 DATES_FULL 로 돌려보냈다.
          full = fullDates.length > 0;
        } else {
          // 기존 시즌: 예전 요일별 판정 그대로
          full = await isOperationalOfferingFull(tx, assignment.offering, scopeOfferingIds, effectiveWeekdays);
        }
        const shuttleRequested = hasSeasonalShuttleSelection(input.items[index]?.shuttle);
        const freeHub = isFreeHubShuttle(input.items[index]?.shuttle);
        // 기간 상품이면 기간 셔틀비(없으면 반 셔틀비), 기간이 없으면 반 셔틀비 — 날짜 모드도 같다
        const normalShuttleFee = assignment.period
          ? resolvePeriodShuttleFee(assignment.period, assignment.offering, shuttleRequested, freeHub)
          : resolveShuttleFee(assignment.offering, shuttleRequested, freeHub);
        // 날짜 모드 중간 합류면 셔틀비도 수강료와 같은 남은 회차 비율·100원 내림(비율 1 이면 그대로)
        const shuttleFeeSnapshot = assignment.proration
          ? proratedPrice(normalShuttleFee, assignment.proration.remainingCount, assignment.proration.fullCount)
          : normalShuttleFee;
        itemPlans.push({
          requested: input.items[index],
          offering: assignment.offering,
          offeringId: assignment.offering.id,
          tuitionPriceSnapshot: assignment.priceSnapshot,
          shuttleFeeSnapshot,
          priceSnapshot: assignment.priceSnapshot + shuttleFeeSnapshot,
          // 반 이름에서 «주N회»를 뺐어도(«초등 고학년») 코드의 횟수를 붙여 남긴다 — 문자·청구서에 «무엇을» 신청했는지 보이게
          titleSnapshot: itemTitleSnapshot(offeringTitleWithFrequency(assignment.offering), {
            mode: input.selectionMode,
            dateCount: input.selectedDates.length,
            periodLabel: assignment.period?.label,
          }),
          offeringPeriodId: assignment.period?.id ?? null,
          sessionCountSnapshot: assignment.sessionCount,
          unitPriceSnapshot: assignment.unitPrice,
          status: full ? "WAITLISTED" : "PENDING",
          waitlistOrder: full ? (maxOrders.get(assignment.offering.id) || 0) + 1 : null,
        });
      }
      const totalPriceSnapshot = totalSnapshot(itemPlans);
      const status = itemPlans.some((item) => item.status === "WAITLISTED") ? "PARTIALLY_WAITLISTED" : "PENDING";

      const application = await tx.specialProgramApplication.create({
        data: {
          seasonId: season.id,
          idempotencyKey: input.idempotencyKey,
          applicantType: applicantDecision.serverType,
          selectedWeekdays: effectiveWeekdays,
          // 기간 선택·날짜별 선택(2026-11-18) — 기간 이름은 서버가 기간 행에서 가져온다
          selectionMode: input.selectionMode,
          selectedDates: attendanceRule.selectedDates ? [...attendanceRule.selectedDates] : [],
          periodLabel: appliedPeriod?.label ?? null,
          periodStartDate: appliedPeriod?.startDate ?? null,
          periodEndDate: appliedPeriod?.endDate ?? null,
          requiresReview: applicantDecision.requiresReview,
          reviewReasons: applicantDecision.reviewReasons,
          childName: input.child.name,
          childBirthDate: new Date(input.child.birthDate),
          childGender: input.child.gender,
          childGrade: input.child.grade,
          childSchool: input.child.school,
          childPhone: input.child.phone,
          parentName: input.parent.name,
          parentPhone: input.parent.phone,
          parentRelation: input.parent.relation,
          address: input.address,
          memo: input.memo,
          // 어떻게 알게 되셨나요(2026-11-18) — 고르지 않으면 NULL. 값은 contracts 가 허용 목록으로 걸렀다
          referralSource: input.referralSource ?? null,
          agreedTerms: input.agreedTerms,
          agreedPrivacy: input.agreedPrivacy,
          status,
          totalPriceSnapshot,
          items: {
            create: itemPlans.map((plan) => ({
              offeringId: plan.offering.id,
              priceSnapshot: plan.priceSnapshot,
              tuitionPriceSnapshot: plan.tuitionPriceSnapshot,
              shuttleFeeSnapshot: plan.shuttleFeeSnapshot,
              titleSnapshot: plan.titleSnapshot,
              offeringPeriodId: plan.offeringPeriodId,
              sessionCountSnapshot: plan.sessionCountSnapshot,
              unitPriceSnapshot: plan.unitPriceSnapshot,
              status: plan.status,
              applicantFingerprint: fingerprint,
              waitlistOrder: plan.waitlistOrder,
            })),
          },
        },
        include: { items: true },
      });

      // 중첩 생성에서는 applicationId를 알기 전이므로 셔틀 요청은 항목 생성 후 저장한다.
      for (const item of application.items) {
        const plan = itemPlans.find((candidate) => candidate.offering.id === item.offeringId);
        const requested = plan?.requested;
        if (!hasSeasonalShuttleSelection(requested?.shuttle) || !requested?.shuttle || !plan?.offering.shuttleAvailable) continue;
        const same = requested.shuttle.dropoffSameAsPickup !== false; // 기본 true(대부분 동일)
        const pickup = requested.shuttle.pickupLocationData;
        // 하원=등원 동일이면 하원 좌표·주소는 등원을 그대로 사용한다.
        const dropoff = same ? pickup : requested.shuttle.dropoffLocationData;
        const confirmedAt = pickup || dropoff ? new Date() : undefined;
        await tx.specialProgramShuttleRequest.create({
          data: {
            applicationId: application.id,
            applicationItemId: item.id,
            pickupLocation: requested.shuttle.pickupLocation,
            pickupTime: requested.shuttle.pickupTime,
            dropoffLocation: same ? requested.shuttle.pickupLocation : requested.shuttle.dropoffLocation,
            dropoffSameAsPickup: same,
            note: requested.shuttle.note,
            pickupAddress: pickup?.address,
            pickupRoadAddress: pickup?.roadAddress,
            pickupLatitude: pickup?.latitude,
            pickupLongitude: pickup?.longitude,
            pickupPlaceId: pickup?.placeId,
            pickupLocationSource: pickup?.source,
            pickupAccuracyMeters: pickup?.accuracyMeters,
            pickupConfirmedAt: pickup ? confirmedAt : undefined,
            dropoffAddress: dropoff?.address,
            dropoffRoadAddress: dropoff?.roadAddress,
            dropoffLatitude: dropoff?.latitude,
            dropoffLongitude: dropoff?.longitude,
            dropoffPlaceId: dropoff?.placeId,
            dropoffLocationSource: dropoff?.source,
            dropoffAccuracyMeters: dropoff?.accuracyMeters,
            dropoffConfirmedAt: dropoff ? confirmedAt : undefined,
            locationConsentVersion: requested.shuttle.locationConsentVersion,
          },
        });
      }

      // 형제할인은 "형제가 같은 시즌을 같이 신청"해야 생긴다.
      // 동생이 나중에 신청하면 먼저 신청한 형/누나도 그때 비로소 대상이 되므로,
      // 신청서를 만든 뒤 시즌 전체를 다시 계산한다(할인 전 수강료에서만 계산하므로 재실행해도 안전).
      await syncSeasonSiblingDiscounts(tx, season.id);
      const priced = await tx.specialProgramApplication.findUnique({
        where: { id: application.id },
        include: { items: true },
      });
      const saved = priced ?? application;

      await tx.specialProgramAuditLog.create({
        data: { seasonId: season.id, applicationId: application.id, actorType: "PUBLIC", action: "APPLICATION_CREATED", afterJSON: { status, totalPriceSnapshot: saved.totalPriceSnapshot } },
      });
      const reservation = await reserveSeasonalParentSms(tx, {
        trigger: SEASONAL_SMS_TRIGGERS.received,
        applicationId: application.id,
        recipientPhone: input.parent.phone,
      });
      return { application: saved, reservation };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    const created = committed.application;
    const response = applicationResponse(created, false);
    const [notification] = await Promise.all([
      committed.reservation.status === "PENDING" && committed.reservation.deliveryId
        ? dispatchSeasonalParentSms({
          deliveryId: committed.reservation.deliveryId,
          trigger: SEASONAL_SMS_TRIGGERS.received,
          recipientPhone: input.parent.phone,
          variables: {
          childName: input.child.name,
          parentName: input.parent.name,
          seasonTitle: season.title,
          offeringTitle: created.items.map((item) => item.titleSnapshot).join(", "),
          waitlistOrder: created.items.filter((item) => item.waitlistOrder).map((item) => String(item.waitlistOrder)).join(", "),
          },
        })
        : Promise.resolve(committed.reservation as SeasonalSmsDeliveryResult),
      notifyAdminsOfNewSeasonalApplication(created, season.title),
    ]);
    return {
      ...response,
      notification,
      ...(notification.status === "FAILED" || notification.errorCode === "TEMPLATE_DISABLED_OR_MISSING"
        ? { notificationWarning: true as const }
        : {}),
    };
  } catch (error) {
    if (error instanceof SeasonalError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const duplicateAfterRace = await existingApplication(season.id, input.idempotencyKey);
      if (duplicateAfterRace) return duplicateApplicationResponse(duplicateAfterRace, season.title);
      // 다른 고유 키 충돌과 동시에 활성 중복이 확인되면 사용자에게 중복 신청으로 안내한다.
      if (await findActiveDuplicate(prisma, input.items.map((item) => item.offeringId), fingerprint)) {
        throw duplicateApplicationError();
      }
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && retryCount < 2) {
      return submitSeasonalApplication(slug, input, retryCount + 1);
    }
    throw error;
  }
}
