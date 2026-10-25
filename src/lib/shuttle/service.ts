import { Prisma, ShuttleRouteDirection, ShuttleRoutePlanStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { effectiveRoles, shuttleScope, type EffectiveRoles } from "@/lib/account/roles";
import { SHUTTLE_LOCATION_CONSENT_VERSION } from "@/lib/seasonal/contracts";
// 셔틀 대상자 판정 기준은 명단·노선·자동배차가 반드시 같아야 한다. 공용 모듈 한 곳에서만 정의한다.
// 셔틀 대상자는 게이트웨이 한 곳으로만 읽는다(원본 4테이블을 여기서 다시 조인하지 않는다).
import { getConfirmedShuttleRoster, applyConfirmedRosterPin } from "@/lib/seasonal/shuttleRoster";
import { assertShuttleCapacity, assertUniqueStopOrders, ShuttleContractError } from "./contracts";
import { resolveAcademyShuttleLocation, type AcademyShuttleLocation } from "./academyLocation";
import { chooseActiveShuttleAssignment } from "./assignment";
import { optimizeWaypointOrderWithTmap, TmapApiError, type TmapWaypoint } from "./tmap";
import { notifyShuttlePassengerNoShow, notifyShuttleRouteConfirmed } from "./notifications";

export class ShuttleServiceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "INVALID_REQUEST",
  ) {
    super(message);
  }
}

function contract<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ShuttleContractError) throw new ShuttleServiceError(error.message, error.status, error.code);
    throw error;
  }
}

type Db = Prisma.TransactionClient;
type Actor = { appUserId: string };
type StaffActor = Actor & {
  appUserRole: "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER";
  /** requireStaff 가 주는 열린 화면 묶음. 없으면 appUserRole 하나로 예전과 똑같이 계산한다. */
  roles?: EffectiveRoles;
};

/**
 * 이 사람이 셔틀 노선을 어디까지 다룰 수 있는가(ALL·OWN·NONE).
 * 역할 하나로 가르면 「선생님 + 기사님」을 표현할 수 없다 — 선생님이라 막히거나, 기사님이라
 * 남의 노선까지 열리거나. roles 가 있으면 그것을, 없으면 예전 appUserRole 로 같은 값을 만든다.
 */
function actorShuttleScope(actor: StaffActor) {
  return shuttleScope(actor.roles ?? effectiveRoles({ primaryRole: actor.appUserRole, hasStudents: false }));
}
type ShuttleRideStatus = "PENDING" | "BOARDED" | "DROPPED_OFF" | "NO_SHOW";
type ShuttleLocationKind = "pickup" | "dropoff";
type StudentShuttleLocationKind = "PICKUP" | "DROPOFF";

const SHUTTLE_RIDE_STATUSES = new Set<ShuttleRideStatus>(["PENDING", "BOARDED", "DROPPED_OFF", "NO_SHOW"]);
const ACADEMY_LATITUDE_ENV = "SHUTTLE_ACADEMY_LATITUDE";
const ACADEMY_LONGITUDE_ENV = "SHUTTLE_ACADEMY_LONGITUDE";
const ACADEMY_NAME_ENV = "SHUTTLE_ACADEMY_NAME";

const routeInclude = {
  vehicle: true,
  driver: { select: { id: true, name: true, phone: true, role: true } },
  stops: {
    orderBy: { stopOrder: "asc" as const },
    include: { passengers: { orderBy: { createdAt: "asc" as const } } },
  },
} satisfies Prisma.ShuttleRoutePlanInclude;

function text(value: unknown, max = 200) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function integer(value: unknown, label: string, min = 0) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new ShuttleServiceError(`${label}을(를) 확인해 주세요.`, 400, "INVALID_NUMBER");
  }
  return parsed;
}

function coordinate(value: unknown, label: string, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ShuttleServiceError(`${label} 좌표를 확인해 주세요.`, 400, "INVALID_COORDINATE");
  }
  return parsed;
}

function optionalCoordinate(value: unknown, label: string, min: number, max: number) {
  if (value === undefined || value === null || value === "") return null;
  return coordinate(value, label, min, max);
}

function optionalDate(value: unknown, label: string, dateOnly = false) {
  if (value === undefined || value === null || value === "") return null;
  const raw = String(value);
  const parsed = new Date(dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw);
  if (Number.isNaN(parsed.getTime())) throw new ShuttleServiceError(`${label}을(를) 확인해 주세요.`, 400, "INVALID_DATE");
  return parsed;
}

function plannedDate(value: unknown, serviceDate: Date | null) {
  if (value === undefined || value === null || value === "") return null;
  const raw = String(value);
  if (/^\d{2}:\d{2}$/.test(raw)) {
    if (!serviceDate) throw new ShuttleServiceError("예정 시간을 입력하려면 운행일을 먼저 지정해 주세요.", 409, "SERVICE_DATE_REQUIRED");
    const day = serviceDate.toISOString().slice(0, 10);
    return optionalDate(`${day}T${raw}:00+09:00`, "예정 시각");
  }
  return optionalDate(value, "예정 시각");
}

export function parseShuttleDirection(value: unknown): ShuttleRouteDirection {
  if (value !== ShuttleRouteDirection.PICKUP && value !== ShuttleRouteDirection.DROPOFF) {
    throw new ShuttleServiceError("등원 또는 하원 방향을 선택해 주세요.", 400, "INVALID_DIRECTION");
  }
  return value;
}

function parseLocationKind(value: unknown): ShuttleLocationKind {
  if (value !== "pickup" && value !== "dropoff") {
    throw new ShuttleServiceError("탑승 또는 하차 위치를 선택해 주세요.", 400, "INVALID_LOCATION_KIND");
  }
  return value;
}

function parseStudentLocationKind(value: unknown): StudentShuttleLocationKind {
  const kind = typeof value === "string" ? value.toUpperCase() : "";
  if (kind !== "PICKUP" && kind !== "DROPOFF") {
    throw new ShuttleServiceError("학생의 등원 또는 하원 위치를 선택해 주세요.", 400, "INVALID_LOCATION_KIND");
  }
  return kind;
}

function dayRange(value: Date) {
  const day = value.toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function point(data: Record<string, unknown>, prefix: "origin" | "destination") {
  const nested = data[prefix] && typeof data[prefix] === "object" ? data[prefix] as Record<string, unknown> : {};
  const name = text(data[`${prefix}Name`] ?? nested.name, 150);
  const address = text(data[`${prefix}Address`] ?? nested.address, 300);
  const latitudeValue = data[`${prefix}Latitude`] ?? data[`${prefix}Lat`] ?? nested.latitude ?? nested.lat;
  const longitudeValue = data[`${prefix}Longitude`] ?? data[`${prefix}Lng`] ?? nested.longitude ?? nested.lng;
  const latitude = latitudeValue === undefined || latitudeValue === null || latitudeValue === ""
    ? null
    : coordinate(latitudeValue, prefix === "origin" ? "출발지" : "도착지", -90, 90);
  const longitude = longitudeValue === undefined || longitudeValue === null || longitudeValue === ""
    ? null
    : coordinate(longitudeValue, prefix === "origin" ? "출발지" : "도착지", -180, 180);
  if ((latitude === null) !== (longitude === null)) {
    throw new ShuttleServiceError("위도와 경도는 함께 입력해 주세요.", 400, "INCOMPLETE_COORDINATE");
  }
  return { [`${prefix}Name`]: name ?? null, [`${prefix}Address`]: address ?? null, [`${prefix}Latitude`]: latitude, [`${prefix}Longitude`]: longitude };
}

function partialPoint(data: Record<string, unknown>, prefix: "origin" | "destination") {
  const keys = [prefix, `${prefix}Name`, `${prefix}Address`, `${prefix}Latitude`, `${prefix}Longitude`, `${prefix}Lat`, `${prefix}Lng`];
  return keys.some((key) => data[key] !== undefined) ? point(data, prefix) : {};
}

function presentRoute<T extends { stops: Array<{ latitude: number; longitude: number; passengers: unknown[] }> }>(route: T) {
  const values = route as T & { originLatitude?: number | null; originLongitude?: number | null; destinationLatitude?: number | null; destinationLongitude?: number | null };
  return {
    ...route,
    originLat: values.originLatitude,
    originLng: values.originLongitude,
    destinationLat: values.destinationLatitude,
    destinationLng: values.destinationLongitude,
    stops: route.stops.map((stop) => ({ ...stop, lat: stop.latitude, lng: stop.longitude })),
  };
}

async function audit(
  tx: Db,
  actor: Actor,
  action: string,
  references: { routePlanId?: string; vehicleId?: string; shuttleRequestId?: string | null },
  beforeJSON?: unknown,
  afterJSON?: unknown,
) {
  await tx.shuttleAuditLog.create({
    data: {
      ...references,
      actorId: actor.appUserId,
      action,
      beforeJSON: beforeJSON === undefined ? undefined : (beforeJSON as Prisma.InputJsonValue),
      afterJSON: afterJSON === undefined ? undefined : (afterJSON as Prisma.InputJsonValue),
    },
  });
}

async function ensureDriver(tx: Db, driverUserId: string) {
  const driver = await tx.user.findFirst({
    where: { id: driverUserId, role: "DRIVER" },
    select: { id: true, name: true, phone: true, role: true },
  });
  if (!driver) throw new ShuttleServiceError("셔틀 기사 계정을 선택해 주세요.", 409, "DRIVER_UNAVAILABLE");
  return driver;
}

type ShuttleClassCandidateRow = {
  sessionId: string;
  classId: string;
  className: string;
  classStartTime: string;
  classEndTime: string;
  lessonTitle: string | null;
  startsAt: Date | string | null;
  endsAt: Date | string | null;
  studentId: string;
  studentName: string;
  studentGrade: string | null;
  studentSchool: string | null;
  parentName: string | null;
  parentPhone: string | null;
  pickupName: string | null;
  pickupAddress: string | null;
  pickupRoadAddress: string | null;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  pickupConfirmedAt: Date | string | null;
  dropoffName: string | null;
  dropoffAddress: string | null;
  dropoffRoadAddress: string | null;
  dropoffLatitude: number | null;
  dropoffLongitude: number | null;
  dropoffConfirmedAt: Date | string | null;
};

function serialLocation(row: ShuttleClassCandidateRow, kind: StudentShuttleLocationKind) {
  const prefix = kind === "PICKUP" ? "pickup" : "dropoff";
  const latitude = row[`${prefix}Latitude` as keyof ShuttleClassCandidateRow] as number | null;
  const longitude = row[`${prefix}Longitude` as keyof ShuttleClassCandidateRow] as number | null;
  const confirmedAt = row[`${prefix}ConfirmedAt` as keyof ShuttleClassCandidateRow] as Date | string | null;
  return {
    kind,
    name: row[`${prefix}Name` as keyof ShuttleClassCandidateRow] as string | null,
    address: row[`${prefix}Address` as keyof ShuttleClassCandidateRow] as string | null,
    roadAddress: row[`${prefix}RoadAddress` as keyof ShuttleClassCandidateRow] as string | null,
    latitude,
    longitude,
    confirmedAt,
    ready: latitude !== null && longitude !== null && confirmedAt !== null,
  };
}

function missingClassCandidateTable(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const detail = JSON.stringify(error.meta ?? {});
  return error.code === "P2010" && (detail.includes("42P01") || detail.includes("42703"));
}

export async function getClassBasedShuttleCandidates(serviceDate: Date) {
  const { start, end } = dayRange(serviceDate);
  let rows: ShuttleClassCandidateRow[];
  try {
    rows = await prisma.$queryRaw<ShuttleClassCandidateRow[]>`
      SELECT
        s.id AS "sessionId",
        c.id AS "classId",
        c.name AS "className",
        c."startTime" AS "classStartTime",
        c."endTime" AS "classEndTime",
        c.name AS "lessonTitle",
        NULL AS "startsAt",
        NULL AS "endsAt",
        st.id AS "studentId",
        st.name AS "studentName",
        st.grade AS "studentGrade",
        st.school AS "studentSchool",
        parent.name AS "parentName",
        COALESCE(st.phone, parent.phone) AS "parentPhone",
        pickup.name AS "pickupName",
        pickup.address AS "pickupAddress",
        pickup."roadAddress" AS "pickupRoadAddress",
        pickup.latitude AS "pickupLatitude",
        pickup.longitude AS "pickupLongitude",
        pickup."confirmedAt" AS "pickupConfirmedAt",
        dropoff.name AS "dropoffName",
        dropoff.address AS "dropoffAddress",
        dropoff."roadAddress" AS "dropoffRoadAddress",
        dropoff.latitude AS "dropoffLatitude",
        dropoff.longitude AS "dropoffLongitude",
        dropoff."confirmedAt" AS "dropoffConfirmedAt"
      FROM "Session" s
      JOIN "Class" c ON c.id = s."classId"
      JOIN "Enrollment" e ON e."classId" = c.id AND e.status = 'ACTIVE'
      -- 병합으로 흡수된 학생 제외 (규칙: src/lib/studentVisibility.ts)
      JOIN "Student" st ON st.id = e."studentId" AND st."mergedIntoStudentId" IS NULL
      LEFT JOIN "User" parent ON parent.id = st."parentId"
      LEFT JOIN "StudentShuttleLocation" pickup ON pickup."studentId" = st.id AND pickup.kind = 'PICKUP'
      LEFT JOIN "StudentShuttleLocation" dropoff ON dropoff."studentId" = st.id AND dropoff.kind = 'DROPOFF'
      WHERE s.date >= ${start} AND s.date < ${end}
      ORDER BY s.date, c."startTime", st.name
    `;
  } catch (error) {
    if (missingClassCandidateTable(error)) {
      return {
        serviceDate: serviceDate.toISOString().slice(0, 10),
        unavailable: true,
        sessions: [],
        totals: { sessions: 0, students: 0, pickupReady: 0, dropoffReady: 0, missingPickup: 0, missingDropoff: 0 },
      };
    }
    throw error;
  }

  const sessions = new Map<string, {
    sessionId: string;
    classId: string;
    className: string;
    lessonTitle: string | null;
    startsAt: Date | string | null;
    endsAt: Date | string | null;
    classStartTime: string;
    classEndTime: string;
    students: Array<{
      studentId: string;
      studentName: string;
      studentGrade: string | null;
      studentSchool: string | null;
      parentName: string | null;
      parentPhone: string | null;
      pickup: ReturnType<typeof serialLocation>;
      dropoff: ReturnType<typeof serialLocation>;
    }>;
  }>();

  for (const row of rows) {
    const session = sessions.get(row.sessionId) ?? {
      sessionId: row.sessionId,
      classId: row.classId,
      className: row.className,
      lessonTitle: row.lessonTitle,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      classStartTime: row.classStartTime,
      classEndTime: row.classEndTime,
      students: [],
    };
    session.students.push({
      studentId: row.studentId,
      studentName: row.studentName,
      studentGrade: row.studentGrade,
      studentSchool: row.studentSchool,
      parentName: row.parentName,
      parentPhone: row.parentPhone,
      pickup: serialLocation(row, "PICKUP"),
      dropoff: serialLocation(row, "DROPOFF"),
    });
    sessions.set(row.sessionId, session);
  }

  const list = Array.from(sessions.values());
  const students = list.flatMap((session) => session.students);
  return {
    serviceDate: serviceDate.toISOString().slice(0, 10),
    unavailable: false,
    sessions: list,
    totals: {
      sessions: list.length,
      students: students.length,
      pickupReady: students.filter((student) => student.pickup.ready).length,
      dropoffReady: students.filter((student) => student.dropoff.ready).length,
      missingPickup: students.filter((student) => !student.pickup.ready).length,
      missingDropoff: students.filter((student) => !student.dropoff.ready).length,
    },
  };
}

export async function getShuttleDashboard(
  seasonId?: string,
  requestedDirection: unknown = ShuttleRouteDirection.PICKUP,
  requestedServiceDate?: unknown,
) {
  const selectedDirection = parseShuttleDirection(requestedDirection);
  const hasServiceDate = requestedServiceDate !== undefined && requestedServiceDate !== null && requestedServiceDate !== "";
  const selectedServiceDate = hasServiceDate ? optionalDate(requestedServiceDate, "운행일", true) : null;
  const seasons = await prisma.specialProgramSeason.findMany({
    orderBy: { startsAt: "desc" },
    select: { id: true, title: true, startsAt: true, endsAt: true },
  });
  const selectedSeasonId = seasonId || seasons[0]?.id || null;
  const [vehicles, routes, rosterEntries, drivers, assignedRequestIds] = await Promise.all([
    prisma.shuttleVehicle.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }] }),
    selectedSeasonId
      ? prisma.shuttleRoutePlan.findMany({
          where: { seasonId: selectedSeasonId },
          orderBy: [{ createdAt: "desc" }, { version: "desc" }],
          include: routeInclude,
        })
      : [],
    // ⚠️ 셔틀 대상자는 원본 테이블에서 직접 찾지 않는다. 게이트웨이만 통과한다.
    //    (여기서 WHERE 절을 손으로 다시 쓰다가 필터가 빠지는 사고가 반복됐다.)
    selectedSeasonId ? getConfirmedShuttleRoster(selectedSeasonId) : [],
    prisma.user.findMany({
      where: { role: "DRIVER" },
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true, phone: true, role: true },
    }),
    // "이미 이 방향(+날짜) 노선에 태워 둔 사람"의 id 집합. 예전에는 findMany의 routePassengers.none
    // 조건이 하던 일을 따로 떼어낸 것이다. 대상자 판정과 배정 여부 판정을 분리해야
    // 대상자 쪽 필터를 게이트웨이 하나로 몰 수 있다.
    prisma.shuttleRoutePassenger.findMany({
      where: {
        shuttleRequestId: { not: null },
        routePlan: {
          status: { not: ShuttleRoutePlanStatus.ARCHIVED },
          direction: selectedDirection,
          ...(hasServiceDate ? { serviceDate: selectedServiceDate } : {}),
        },
      },
      select: { shuttleRequestId: true },
    }),
  ]);

  const assignedIds = new Set(assignedRequestIds.map((row) => row.shuttleRequestId).filter(Boolean) as string[]);
  const unassignedRequests = rosterEntries
    // 미탑승으로 눌러 둔 학생은 노선 편성 후보가 아니다(통합 명단에서는 회색 행으로 남는다).
    .filter((entry) => entry.ride && !assignedIds.has(entry.shuttleRequestId))
    // 기존 화면 순서(신청 접수순)를 유지한다.
    // ⚠️ 다만 2026-07-21 일괄 등록분 9건은 createdAt이 **완전히 같아서** 예전 정렬은 사실상 무작위였다
    //    (DB가 돌려주는 물리적 순서. 행을 한 번 수정하면 순서가 또 바뀐다).
    //    그래서 동점일 때는 이름순으로 고정한다 — 통합 명단 화면과 같은 기준이라 찾기도 쉽다.
    .sort((left, right) =>
      (left.requestCreatedAt?.getTime() ?? 0) - (right.requestCreatedAt?.getTime() ?? 0) ||
      left.studentName.localeCompare(right.studentName, "ko"),
    )
    .map((entry) => ({
      id: entry.shuttleRequestId,
      applicationItemId: entry.applicationItemId,
      childName: entry.studentName,
      parentName: entry.parentName,
      parentPhone: entry.parentPhone,
      offeringTitle: entry.offeringTitle,
      pickup: {
        name: entry.pickup.location,
        address: entry.pickup.address,
        roadAddress: entry.pickup.roadAddress,
        lat: entry.pickup.latitude,
        lng: entry.pickup.longitude,
        placeId: entry.pickup.placeId,
        source: entry.pickup.source,
        accuracyMeters: entry.pickup.accuracyMeters,
        confirmedAt: entry.pickup.confirmedAt,
      },
      dropoff: {
        name: entry.dropoff.location,
        address: entry.dropoff.address,
        roadAddress: entry.dropoff.roadAddress,
        lat: entry.dropoff.latitude,
        lng: entry.dropoff.longitude,
        placeId: entry.dropoff.placeId,
        source: entry.dropoff.source,
        accuracyMeters: entry.dropoff.accuracyMeters,
        confirmedAt: entry.dropoff.confirmedAt,
      },
      pickupTime: entry.pickupTime,
      note: entry.note,
    }));
  const classBasedCandidates = selectedServiceDate ? await getClassBasedShuttleCandidates(selectedServiceDate) : null;
  // 노선 만들기 모달의 "학원으로 채우기" 버튼이 쓸 값. 없으면 null이고 버튼은 비활성화된다.
  const academyLocation = await getAcademyShuttleLocation();

  return {
    seasons,
    selectedSeasonId,
    selectedDirection,
    selectedServiceDate,
    academyLocation,
    vehicles,
    drivers,
    routes: routes.map((route) => ({
      ...presentRoute(route),
      passengerCount: route.stops.reduce((sum, stop) => sum + stop.passengers.length, 0),
    })),
    unassignedRequests,
    classBasedCandidates,
  };
}

export async function createVehicle(actor: Actor, input: Record<string, unknown>) {
  const name = text(input.name, 100);
  if (!name) throw new ShuttleServiceError("차량 이름을 입력해 주세요.", 400, "VEHICLE_NAME_REQUIRED");
  const capacity = integer(input.capacity, "정원", 1);
  return prisma.$transaction(async (tx) => {
    const vehicle = await tx.shuttleVehicle.create({
      data: { name, capacity, plateNumber: text(input.plateNumber, 30), notes: text(input.notes, 1000) },
    });
    await audit(tx, actor, "VEHICLE_CREATED", { vehicleId: vehicle.id }, undefined, vehicle);
    return vehicle;
  });
}

export async function updateVehicle(actor: Actor, id: string, input: Record<string, unknown>) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.shuttleVehicle.findUnique({ where: { id } });
    if (!before) throw new ShuttleServiceError("차량을 찾을 수 없습니다.", 404, "VEHICLE_NOT_FOUND");
    const data: Prisma.ShuttleVehicleUpdateInput = {};
    const nextCapacity = input.capacity !== undefined ? integer(input.capacity, "정원", 1) : null;
    if (input.name !== undefined) data.name = text(input.name, 100) || (() => { throw new ShuttleServiceError("차량 이름을 입력해 주세요."); })();
    if (nextCapacity !== null) data.capacity = nextCapacity;
    if (input.plateNumber !== undefined) data.plateNumber = text(input.plateNumber, 30) ?? null;
    if (input.notes !== undefined) data.notes = text(input.notes, 1000) ?? null;
    if (input.isActive !== undefined) data.isActive = input.isActive === true;
    const activePlans = await tx.shuttleRoutePlan.findMany({
      where: { vehicleId: id, status: { not: ShuttleRoutePlanStatus.ARCHIVED } },
      select: { id: true, status: true, _count: { select: { passengers: true } } },
    });
    if (nextCapacity !== null && activePlans.some((plan) => plan._count.passengers > nextCapacity)) {
      throw new ShuttleServiceError("현재 노선의 탑승 인원보다 차량 정원을 줄일 수 없습니다.", 409, "VEHICLE_CAPACITY_IN_USE");
    }
    if (data.isActive === false && activePlans.some((plan) => plan.status === ShuttleRoutePlanStatus.CONFIRMED)) {
      throw new ShuttleServiceError("확정 노선에 배정된 차량은 비활성화할 수 없습니다.", 409, "VEHICLE_IN_CONFIRMED_ROUTE");
    }
    const vehicle = await tx.shuttleVehicle.update({ where: { id }, data });
    await audit(tx, actor, "VEHICLE_UPDATED", { vehicleId: id }, before, vehicle);
    return vehicle;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function createRoute(actor: Actor, input: Record<string, unknown>) {
  const seasonId = text(input.seasonId, 100);
  const name = text(input.name, 150);
  if (!seasonId || !name) throw new ShuttleServiceError("시즌과 노선 이름을 입력해 주세요.", 400, "ROUTE_FIELDS_REQUIRED");
  const routeDirection = parseShuttleDirection(input.direction);
  return prisma.$transaction(async (tx) => {
    const season = await tx.specialProgramSeason.findUnique({ where: { id: seasonId }, select: { id: true } });
    if (!season) throw new ShuttleServiceError("방학특강 시즌을 찾을 수 없습니다.", 404, "SEASON_NOT_FOUND");
    const vehicleId = text(input.vehicleId, 100);
    if (vehicleId) await ensureVehicle(tx, vehicleId);
    const driverUserId = text(input.driverUserId, 100);
    if (driverUserId) await ensureDriver(tx, driverUserId);
    const routeKey = crypto.randomUUID();
    const route = await tx.shuttleRoutePlan.create({
      data: {
        seasonId,
        vehicleId,
        driverUserId,
        routeKey,
        version: 1,
        name,
        direction: routeDirection,
        serviceDate: optionalDate(input.serviceDate, "운행일", true),
        ...point(input, "origin"),
        ...point(input, "destination"),
      },
      include: routeInclude,
    });
    await audit(tx, actor, "ROUTE_CREATED", { routePlanId: route.id }, undefined, route);
    return route;
  });
}

async function ensureVehicle(tx: Db, vehicleId: string) {
  const vehicle = await tx.shuttleVehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle || !vehicle.isActive) throw new ShuttleServiceError("사용 가능한 차량을 찾을 수 없습니다.", 409, "VEHICLE_UNAVAILABLE");
  return vehicle;
}

async function draftRoute(tx: Db, id: string) {
  const route = await tx.shuttleRoutePlan.findUnique({ where: { id }, include: routeInclude });
  if (!route) throw new ShuttleServiceError("노선을 찾을 수 없습니다.", 404, "ROUTE_NOT_FOUND");
  if (route.status !== ShuttleRoutePlanStatus.DRAFT) {
    throw new ShuttleServiceError("확정된 노선은 직접 수정할 수 없습니다. 새 수정본을 만들어 주세요.", 409, "ROUTE_LOCKED");
  }
  return route;
}

async function syncLegacyAssignment(tx: Db, shuttleRequestId: string | null | undefined, preferredRouteId?: string) {
  if (!shuttleRequestId) return;
  const active = await tx.shuttleRoutePassenger.findMany({
    where: { shuttleRequestId, routePlan: { status: { not: ShuttleRoutePlanStatus.ARCHIVED } } },
    include: { routePlan: { select: { id: true, status: true, updatedAt: true } } },
    orderBy: { updatedAt: "desc" },
  });
  const selected = chooseActiveShuttleAssignment(active, preferredRouteId);
  await tx.specialProgramShuttleRequest.update({
    where: { id: shuttleRequestId },
    data: selected
      ? { assignedRouteId: selected.routePlanId, assignedStopId: selected.stopId, status: "ASSIGNED" }
      : { assignedRouteId: null, assignedStopId: null, status: "REQUESTED" },
  });
}

export async function updateRoute(actor: Actor, id: string, input: Record<string, unknown>) {
  return prisma.$transaction(async (tx) => {
    const before = await draftRoute(tx, id);
    const data: Prisma.ShuttleRoutePlanUpdateInput = {};
    if (input.name !== undefined) data.name = text(input.name, 150) || (() => { throw new ShuttleServiceError("노선 이름을 입력해 주세요."); })();
    if (input.vehicleId !== undefined) {
      const vehicleId = text(input.vehicleId, 100);
      if (vehicleId) {
        const vehicle = await ensureVehicle(tx, vehicleId);
        const passengerCount = before.stops.reduce((sum, stop) => sum + stop.passengers.length, 0);
        if (passengerCount > vehicle.capacity) throw new ShuttleServiceError("차량 정원을 초과할 수 없습니다.", 409, "VEHICLE_CAPACITY_EXCEEDED");
      }
      data.vehicle = vehicleId ? { connect: { id: vehicleId } } : { disconnect: true };
    }
    if (input.driverUserId !== undefined) {
      const driverUserId = text(input.driverUserId, 100);
      if (driverUserId) {
        await ensureDriver(tx, driverUserId);
        data.driver = { connect: { id: driverUserId } };
      } else {
        data.driver = { disconnect: true };
      }
    }
    if (input.serviceDate !== undefined) {
      const nextServiceDate = optionalDate(input.serviceDate, "운행일", true);
      const shuttleRequestIds = before.stops
        .flatMap((stop) => stop.passengers.map((passenger) => passenger.shuttleRequestId))
        .filter((requestId): requestId is string => Boolean(requestId));
      if (shuttleRequestIds.length) {
        const duplicate = await tx.shuttleRoutePassenger.findFirst({
          where: {
            shuttleRequestId: { in: shuttleRequestIds },
            routePlan: {
              id: { not: id }, seasonId: before.seasonId, direction: before.direction,
              serviceDate: nextServiceDate, status: { not: ShuttleRoutePlanStatus.ARCHIVED },
            },
          },
          select: { id: true },
        });
        if (duplicate) throw new ShuttleServiceError("변경할 운행일에 이미 배정된 학생이 있습니다.", 409, "DUPLICATE_ASSIGNMENT");
      }
      data.serviceDate = nextServiceDate;
    }
    Object.assign(data, partialPoint(input, "origin"), partialPoint(input, "destination"));
    const route = await tx.shuttleRoutePlan.update({ where: { id }, data, include: routeInclude });
    await audit(tx, actor, "ROUTE_UPDATED", { routePlanId: id }, before, route);
    return route;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function previewOptimizedRouteStops(actor: Actor, routeId: string) {
  void actor;
  const route = await prisma.shuttleRoutePlan.findUnique({ where: { id: routeId }, include: routeInclude });
  if (!route) throw new ShuttleServiceError("Route not found.", 404, "ROUTE_NOT_FOUND");
  if (route.status !== ShuttleRoutePlanStatus.DRAFT) {
    throw new ShuttleServiceError("Only draft routes can be optimized.", 409, "ROUTE_LOCKED");
  }
  if (route.stops.length < 2) {
    throw new ShuttleServiceError("At least two stops are required for TMAP optimization.", 400, "NOT_ENOUGH_STOPS");
  }
  if (
    route.originLatitude === null ||
    route.originLongitude === null ||
    route.destinationLatitude === null ||
    route.destinationLongitude === null
  ) {
    throw new ShuttleServiceError("Origin and destination coordinates are required for TMAP optimization.", 409, "ROUTE_ENDPOINTS_REQUIRED");
  }

  const sortedStops = [...route.stops].sort((a, b) => a.stopOrder - b.stopOrder);
  let result;
  try {
    result = await optimizeWaypointOrderWithTmap({
      start: {
        id: "origin",
        name: route.originName || route.originAddress || "출발지",
        latitude: route.originLatitude,
        longitude: route.originLongitude,
      },
      end: {
        id: "destination",
        name: route.destinationName || route.destinationAddress || "도착지",
        latitude: route.destinationLatitude,
        longitude: route.destinationLongitude,
      },
      waypoints: sortedStops.map((stop) => ({
        id: stop.id,
        name: stop.name,
        latitude: stop.latitude,
        longitude: stop.longitude,
      })),
    });
  } catch (error) {
    if (error instanceof TmapApiError) {
      throw new ShuttleServiceError(error.message, error.status, error.code);
    }
    throw new ShuttleServiceError(
      error instanceof Error ? error.message : "Failed to load TMAP optimized stop order.",
      502,
      "TMAP_OPTIMIZATION_FAILED",
    );
  }
  const stopById = new Map(sortedStops.map((stop) => [stop.id, stop]));
  const optimizedStops = result.orderedWaypointIds.map((id, index) => {
    const stop = stopById.get(id);
    if (!stop) throw new ShuttleServiceError("Optimized stop result does not match route stops.", 502, "OPTIMIZED_STOP_MISMATCH");
    return {
      id: stop.id,
      previousOrder: stop.stopOrder,
      recommendedOrder: index + 1,
      name: stop.name,
      address: stop.roadAddress || stop.address,
      passengerCount: stop.passengers.length,
    };
  });
  return {
    provider: result.provider,
    routeId,
    routeName: route.name,
    stops: optimizedStops,
    totalDistance: result.rawSummary?.totalDistance,
    totalTime: result.rawSummary?.totalTime,
  };
}

/**
 * 학원(셔틀 기준점) 위치를 읽는다. 정본은 DB(AcademySettings), 없으면 기존 환경변수.
 *
 * DB를 먼저 보는 이유: 환경변수는 배포 환경마다 따로 넣어야 해서 한 곳만 빠지면
 * 반별 자동배치가 409로 죽는데, 원장이 스스로 고칠 방법이 없었다. 이제 관리자 설정 화면에서
 * 지도로 찍어 고칠 수 있다. 환경변수는 DB 컬럼이 비어 있는 환경을 위한 fallback으로 남긴다.
 *
 * 실패해도 화면 전체가 죽으면 안 되므로(예: 셔틀 대시보드 첫 로딩) 조회 오류는 삼키고
 * 환경변수 쪽으로 넘긴다. 값이 아예 없을 때 던지는 판단은 호출부(requireAcademyWaypoint)가 한다.
 */
export async function getAcademyShuttleLocation(): Promise<AcademyShuttleLocation | null> {
  let settings: Record<string, unknown> | null = null;
  try {
    // PgBouncer 트랜잭션 모드 호환을 위해 $queryRawUnsafe(simple query protocol)를 쓴다.
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT "academyPlaceName", "academyAddress", "academyLatitude", "academyLongitude"
         FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`,
    );
    settings = rows[0] ?? null;
  } catch (error) {
    // 컬럼이 아직 없는 환경(마이그레이션 미적용)에서도 환경변수로 계속 동작해야 한다.
    console.warn("[shuttle] AcademySettings 학원 좌표 조회 실패 — 환경변수로 대체합니다.", (error as Error).message);
  }
  return resolveAcademyShuttleLocation({
    settings: settings
      ? { name: settings.academyPlaceName, address: settings.academyAddress, latitude: settings.academyLatitude, longitude: settings.academyLongitude }
      : null,
    env: {
      name: process.env[ACADEMY_NAME_ENV],
      latitude: process.env[ACADEMY_LATITUDE_ENV],
      longitude: process.env[ACADEMY_LONGITUDE_ENV],
    },
  });
}

/** 자동배치처럼 학원 좌표가 반드시 있어야 하는 경로에서 쓴다. 없으면 어디서 고치는지 안내한다. */
async function requireAcademyWaypoint(): Promise<TmapWaypoint & { address: string | null }> {
  const academy = await getAcademyShuttleLocation();
  if (!academy) {
    throw new ShuttleServiceError(
      "학원 위치가 아직 등록되지 않았습니다. 관리자 → 설정 → 연락처 및 위치에서 학원 위치를 지도로 지정해 주세요.",
      409,
      "ACADEMY_COORDINATES_REQUIRED",
    );
  }
  return { id: "academy", name: academy.name, address: academy.address, latitude: academy.latitude, longitude: academy.longitude };
}

function readyCandidateLocation(
  student: Awaited<ReturnType<typeof getClassBasedShuttleCandidates>>["sessions"][number]["students"][number],
  kind: "PICKUP" | "DROPOFF",
) {
  const location = kind === "PICKUP" ? student.pickup : student.dropoff;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!location.ready || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { location, latitude, longitude };
}

export async function previewClassBasedShuttlePlacement(actor: Actor, input: Record<string, unknown>) {
  void actor;
  const serviceDate = optionalDate(input.serviceDate, "serviceDate", true);
  if (!serviceDate) throw new ShuttleServiceError("serviceDate is required.", 400, "SERVICE_DATE_REQUIRED");
  const direction = parseShuttleDirection(input.direction);
  const locationKind = direction === ShuttleRouteDirection.PICKUP ? "PICKUP" : "DROPOFF";
  const candidates = await getClassBasedShuttleCandidates(serviceDate);
  if (candidates.unavailable) {
    throw new ShuttleServiceError("Student shuttle location table is not available.", 409, "STUDENT_LOCATION_TABLE_UNAVAILABLE");
  }

  const academy = await requireAcademyWaypoint();
  const missingStudents: Array<{ studentId: string; studentName: string; className: string; reason: string }> = [];
  const waypoints: Array<TmapWaypoint & {
    studentId: string;
    studentName: string;
    className: string;
    sessionId: string;
    address?: string | null;
    parentName?: string | null;
    parentPhone?: string | null;
    classStartTime?: string | null;
    classEndTime?: string | null;
  }> = [];

  for (const session of candidates.sessions) {
    for (const student of session.students) {
      const ready = readyCandidateLocation(student, locationKind);
      if (!ready) {
        missingStudents.push({
          studentId: student.studentId,
          studentName: student.studentName,
          className: session.className,
          reason: locationKind === "PICKUP" ? "PICKUP_LOCATION_REQUIRED" : "DROPOFF_LOCATION_REQUIRED",
        });
        continue;
      }
      waypoints.push({
        id: `${session.sessionId}:${student.studentId}:${locationKind}`,
        studentId: student.studentId,
        studentName: student.studentName,
        className: session.className,
        sessionId: session.sessionId,
        name: `${student.studentName} ${locationKind === "PICKUP" ? "pickup" : "dropoff"}`,
        address: ready.location.roadAddress || ready.location.address || ready.location.name,
        parentName: student.parentName,
        parentPhone: student.parentPhone,
        latitude: ready.latitude,
        longitude: ready.longitude,
        classStartTime: session.classStartTime,
        classEndTime: session.classEndTime,
      });
    }
  }

  if (waypoints.length > 100) {
    throw new ShuttleServiceError("Tmap optimization supports up to 100 class based shuttle stops.", 400, "TOO_MANY_STOPS");
  }

  const fallbackOrder = waypoints.map((point) => point.id);
  let provider = "LOCAL";
  let orderedWaypointIds = fallbackOrder;
  let rawSummary: { totalDistance?: number; totalTime?: number } | undefined;
  let warning: string | undefined;

  if (waypoints.length >= 2) {
    try {
      const result = await optimizeWaypointOrderWithTmap({
        start: academy,
        end: academy,
        waypoints,
      });
      provider = result.provider;
      orderedWaypointIds = result.orderedWaypointIds;
      rawSummary = result.rawSummary;
    } catch (error) {
      if (error instanceof TmapApiError) {
        throw new ShuttleServiceError(error.message, error.status, error.code);
      }
      throw new ShuttleServiceError(
        error instanceof Error ? error.message : "Failed to load TMAP class based placement.",
        502,
        "TMAP_OPTIMIZATION_FAILED",
      );
    }
  } else {
    warning = waypoints.length === 1 ? "NOT_ENOUGH_WAYPOINTS" : "NO_READY_WAYPOINTS";
  }

  const waypointById = new Map(waypoints.map((point) => [point.id, point]));
  const stops = orderedWaypointIds.map((id, index) => {
    const waypoint = waypointById.get(id);
    if (!waypoint) throw new ShuttleServiceError("Optimized class candidate result does not match waypoints.", 502, "OPTIMIZED_CLASS_CANDIDATE_MISMATCH");
    return {
      id: waypoint.id,
      recommendedOrder: index + 1,
      studentId: waypoint.studentId,
      studentName: waypoint.studentName,
      className: waypoint.className,
      sessionId: waypoint.sessionId,
      address: waypoint.address,
      parentName: waypoint.parentName,
      parentPhone: waypoint.parentPhone,
      latitude: waypoint.latitude,
      longitude: waypoint.longitude,
      classStartTime: waypoint.classStartTime,
      classEndTime: waypoint.classEndTime,
    };
  });

  return {
    provider,
    serviceDate: serviceDate.toISOString().slice(0, 10),
    direction,
    academy,
    stops,
    missingStudents,
    warning,
    totalDistance: rawSummary?.totalDistance,
    totalTime: rawSummary?.totalTime,
    totals: {
      readyStops: stops.length,
      missingStops: missingStudents.length,
      sessions: candidates.totals.sessions,
      students: candidates.totals.students,
    },
  };
}

export async function createClassBasedShuttleRouteDraft(actor: Actor, input: Record<string, unknown>) {
  const seasonId = text(input.seasonId, 100);
  if (!seasonId) throw new ShuttleServiceError("시즌을 선택해 주세요.", 400, "SEASON_REQUIRED");
  const preview = await previewClassBasedShuttlePlacement(actor, input);
  if (!preview.stops.length) {
    throw new ShuttleServiceError("노선 초안을 만들 학생 위치가 없습니다.", 409, "NO_READY_WAYPOINTS");
  }

  const vehicleId = text(input.vehicleId, 100);
  const driverUserId = text(input.driverUserId, 100);
  const routeName = text(input.name, 150)
    || `${preview.serviceDate} ${preview.direction === ShuttleRouteDirection.PICKUP ? "등원" : "하원"} 자동 배치`;
  const locationKind = preview.direction === ShuttleRouteDirection.PICKUP ? "PICKUP" : "DROPOFF";

  return prisma.$transaction(async (tx) => {
    const season = await tx.specialProgramSeason.findUnique({ where: { id: seasonId }, select: { id: true } });
    if (!season) throw new ShuttleServiceError("방학특강 시즌을 찾을 수 없습니다.", 404, "SEASON_NOT_FOUND");
    if (vehicleId) {
      const vehicle = await ensureVehicle(tx, vehicleId);
      contract(() => assertShuttleCapacity(vehicle.capacity, preview.stops.length));
    }
    if (driverUserId) await ensureDriver(tx, driverUserId);

    const route = await tx.shuttleRoutePlan.create({
      data: {
        seasonId,
        vehicleId,
        driverUserId,
        routeKey: crypto.randomUUID(),
        version: 1,
        name: routeName,
        direction: preview.direction,
        serviceDate: new Date(`${preview.serviceDate}T00:00:00.000Z`),
        // 주소가 등록돼 있으면 진짜 주소를 넣는다(예전엔 주소 칸에도 장소명을 넣고 있었다).
        originName: preview.academy.name,
        originAddress: preview.academy.address || preview.academy.name,
        originLatitude: preview.academy.latitude,
        originLongitude: preview.academy.longitude,
        destinationName: preview.academy.name,
        destinationAddress: preview.academy.address || preview.academy.name,
        destinationLatitude: preview.academy.latitude,
        destinationLongitude: preview.academy.longitude,
      },
    });

    for (const stop of preview.stops) {
      const routeStop = await tx.shuttleRouteStop.create({
        data: {
          routePlanId: route.id,
          stopOrder: stop.recommendedOrder,
          name: `${stop.studentName} ${locationKind === "PICKUP" ? "등원" : "하원"}`,
          address: stop.address || "주소 미입력",
          roadAddress: stop.address || undefined,
          latitude: stop.latitude,
          longitude: stop.longitude,
          note: `${stop.className}${stop.classStartTime ? ` · ${stop.classStartTime}` : ""}`,
        },
      });
      await tx.$executeRaw`
        INSERT INTO "ShuttleRoutePassenger" (
          "routePlanId", "stopId", "sourceType", "studentId", "sessionId", "locationKind",
          "studentNameSnapshot", "parentNameSnapshot", "parentPhoneSnapshot", "note",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${route.id}, ${routeStop.id}, 'REGULAR_CLASS', ${stop.studentId}, ${stop.sessionId}, ${locationKind},
          ${stop.studentName}, ${stop.parentName ?? null}, ${stop.parentPhone ?? null}, ${stop.className},
          NOW(), NOW()
        )
      `;
    }

    const created = await tx.shuttleRoutePlan.findUniqueOrThrow({ where: { id: route.id }, include: routeInclude });
    await audit(tx, actor, "CLASS_BASED_ROUTE_DRAFT_CREATED", { routePlanId: route.id }, undefined, { route: created, preview });
    return created;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function updateShuttleRequestLocation(actor: Actor, shuttleRequestId: string, input: Record<string, unknown>) {
  const kind = parseLocationKind(input.kind);
  const nested = input.location && typeof input.location === "object" ? input.location as Record<string, unknown> : {};
  const address = text(input.address ?? nested.address, 300);
  const roadAddress = text(input.roadAddress ?? nested.roadAddress, 300);
  const name = text(input.name ?? input.locationName ?? nested.name, 150) ?? roadAddress ?? address;
  const latitude = optionalCoordinate(input.latitude ?? input.lat ?? nested.latitude ?? nested.lat, kind === "pickup" ? "탑승 위치" : "하차 위치", -90, 90);
  const longitude = optionalCoordinate(input.longitude ?? input.lng ?? nested.longitude ?? nested.lng, kind === "pickup" ? "탑승 위치" : "하차 위치", -180, 180);
  if (latitude === null || longitude === null) {
    throw new ShuttleServiceError("지도에서 찍은 좌표가 필요합니다.", 400, "COORDINATES_REQUIRED");
  }
  if (!address && !roadAddress && !name) {
    throw new ShuttleServiceError("지도에서 확인한 주소가 필요합니다.", 400, "ADDRESS_REQUIRED");
  }
  const placeId = text(input.placeId ?? nested.placeId, 200);
  const source = text(input.source ?? nested.source, 30) ?? "ADMIN_PIN";
  const accuracyValue = input.accuracyMeters ?? nested.accuracyMeters;
  const accuracyMeters = accuracyValue === undefined || accuracyValue === null || accuracyValue === ""
    ? null
    : coordinate(accuracyValue, "위치 정확도", 0, 100_000);

  // ★ 이 화면의 명단은 확정본(게이트웨이)에서 읽는다. 그런데 저장을 원본에만 하면
  //   핀을 찍어도 좌표가 그대로인 채 "저장했습니다"만 뜬다(에러도 로그도 없는 조용한 no-op).
  //   읽는 곳과 쓰는 곳이 갈리면 반드시 이렇게 되므로, 확정본이 있으면 확정본에 쓴다.
  const routed = await applyConfirmedRosterPin(
    shuttleRequestId,
    kind,
    { latitude, longitude, address, roadAddress, source, placeId, accuracyMeters },
    name,
  ).catch((error: unknown) => {
    // 확정본 수정은 원장(ADMIN) 권한이 필요하다. 부원장이면 조용히 원본에 쓰지 말고 이유를 알린다.
    const message = error instanceof Error ? error.message : "";
    if (/원장|ADMIN/.test(message)) {
      throw new ShuttleServiceError("확정된 명단의 위치는 원장(ADMIN)만 수정할 수 있습니다.", 403, "CONFIRMED_ROSTER_OWNER_ONLY");
    }
    throw error;
  });
  if (routed.applied) {
    // 원본 신청서는 건드리지 않는다(확정 후 원본 불변). 감사 로그만 남긴다.
    await audit(prisma, actor, "SHUTTLE_LOCATION_CONFIRMED", { shuttleRequestId }, null, {
      target: "SeasonalShuttleRoster", kind, latitude, longitude, address, roadAddress, source,
    });
    return { id: shuttleRequestId, confirmedRoster: true, kind, latitude, longitude };
  }

  return prisma.$transaction(async (tx) => {
    const before = await tx.specialProgramShuttleRequest.findUnique({
      where: { id: shuttleRequestId },
      include: { application: true, applicationItem: { include: { offering: { select: { title: true } } } } },
    });
    if (!before) throw new ShuttleServiceError("셔틀 신청을 찾을 수 없습니다.", 404, "REQUEST_NOT_FOUND");
    const data: Prisma.SpecialProgramShuttleRequestUpdateInput = kind === "pickup"
      ? {
          pickupLocation: name ?? address ?? roadAddress ?? null,
          pickupAddress: address ?? roadAddress ?? name ?? null,
          pickupRoadAddress: roadAddress ?? null,
          pickupLatitude: latitude,
          pickupLongitude: longitude,
          pickupPlaceId: placeId ?? null,
          pickupLocationSource: source,
          pickupAccuracyMeters: accuracyMeters,
          pickupConfirmedAt: new Date(),
          locationConsentVersion: SHUTTLE_LOCATION_CONSENT_VERSION,
        }
      : {
          dropoffLocation: name ?? address ?? roadAddress ?? null,
          dropoffAddress: address ?? roadAddress ?? name ?? null,
          dropoffRoadAddress: roadAddress ?? null,
          dropoffLatitude: latitude,
          dropoffLongitude: longitude,
          dropoffPlaceId: placeId ?? null,
          dropoffLocationSource: source,
          dropoffAccuracyMeters: accuracyMeters,
          dropoffConfirmedAt: new Date(),
          locationConsentVersion: SHUTTLE_LOCATION_CONSENT_VERSION,
        };
    const request = await tx.specialProgramShuttleRequest.update({
      where: { id: shuttleRequestId },
      data,
      include: { application: true, applicationItem: { include: { offering: { select: { title: true } } } } },
    });
    await audit(tx, actor, "SHUTTLE_LOCATION_CONFIRMED", { shuttleRequestId }, before, request);
    return request;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function updateStudentShuttleLocation(actor: Actor, studentId: string, input: Record<string, unknown>) {
  const kind = parseStudentLocationKind(input.kind);
  const nested = input.location && typeof input.location === "object" ? input.location as Record<string, unknown> : {};
  const address = text(input.address ?? nested.address, 300);
  const roadAddress = text(input.roadAddress ?? nested.roadAddress, 300);
  const name = text(input.name ?? input.locationName ?? nested.name, 150) ?? roadAddress ?? address;
  const latitude = optionalCoordinate(input.latitude ?? input.lat ?? nested.latitude ?? nested.lat, "학생 위치", -90, 90);
  const longitude = optionalCoordinate(input.longitude ?? input.lng ?? nested.longitude ?? nested.lng, "학생 위치", -180, 180);
  if (latitude === null || longitude === null) {
    throw new ShuttleServiceError("학생 위치 좌표가 필요합니다.", 400, "COORDINATES_REQUIRED");
  }
  if (!address && !roadAddress && !name) {
    throw new ShuttleServiceError("학생 위치 주소가 필요합니다.", 400, "ADDRESS_REQUIRED");
  }
  const placeId = text(input.placeId ?? nested.placeId, 200);
  const source = text(input.source ?? nested.source, 30) ?? "ADMIN_PIN";
  const note = text(input.note ?? nested.note, 1000);
  const accuracyValue = input.accuracyMeters ?? nested.accuracyMeters;
  const accuracyMeters = accuracyValue === undefined || accuracyValue === null || accuracyValue === ""
    ? null
    : coordinate(accuracyValue, "학생 위치 정확도", 0, 100_000);

  return prisma.$transaction(async (tx) => {
    const student = await tx.student.findUnique({ where: { id: studentId }, select: { id: true, name: true } });
    if (!student) throw new ShuttleServiceError("학생을 찾을 수 없습니다.", 404, "STUDENT_NOT_FOUND");
    const [location] = await tx.$queryRaw<Array<Record<string, unknown>>>`
      INSERT INTO "StudentShuttleLocation" (
        "studentId", kind, name, address, "roadAddress", latitude, longitude,
        "placeId", source, "accuracyMeters", "confirmedAt", "consentVersion", note,
        "createdAt", "updatedAt"
      )
      VALUES (
        ${studentId}, ${kind}, ${name ?? address ?? roadAddress}, ${address ?? roadAddress ?? name},
        ${roadAddress ?? null}, ${latitude}, ${longitude}, ${placeId ?? null}, ${source},
        ${accuracyMeters}, NOW(), ${SHUTTLE_LOCATION_CONSENT_VERSION}, ${note ?? null}, NOW(), NOW()
      )
      ON CONFLICT ("studentId", kind) DO UPDATE SET
        name = EXCLUDED.name,
        address = EXCLUDED.address,
        "roadAddress" = EXCLUDED."roadAddress",
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        "placeId" = EXCLUDED."placeId",
        source = EXCLUDED.source,
        "accuracyMeters" = EXCLUDED."accuracyMeters",
        "confirmedAt" = EXCLUDED."confirmedAt",
        "consentVersion" = EXCLUDED."consentVersion",
        note = EXCLUDED.note,
        "updatedAt" = NOW()
      RETURNING *
    `;
    await audit(tx, actor, "STUDENT_SHUTTLE_LOCATION_CONFIRMED", {}, undefined, { student, location });
    return location;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function assignPassenger(actor: Actor, routeId: string, input: Record<string, unknown>) {
  const shuttleRequestId = text(input.shuttleRequestId, 100);
  const stopInput = input.stop && typeof input.stop === "object" ? input.stop as Record<string, unknown> : {};
  if (!shuttleRequestId) throw new ShuttleServiceError("셔틀 신청을 선택해 주세요.", 400, "REQUEST_REQUIRED");
  return prisma.$transaction(async (tx) => {
    const route = await draftRoute(tx, routeId);
    const request = await tx.specialProgramShuttleRequest.findUnique({
      where: { id: shuttleRequestId },
      include: { application: true },
    });
    if (!request || request.application.seasonId !== route.seasonId) {
      throw new ShuttleServiceError("해당 시즌의 셔틀 신청을 찾을 수 없습니다.", 404, "REQUEST_NOT_FOUND");
    }
    const location = route.direction === ShuttleRouteDirection.PICKUP
      ? { name: request.pickupLocation, address: request.pickupAddress, roadAddress: request.pickupRoadAddress, latitude: request.pickupLatitude, longitude: request.pickupLongitude, confirmedAt: request.pickupConfirmedAt }
      : { name: request.dropoffLocation, address: request.dropoffAddress, roadAddress: request.dropoffRoadAddress, latitude: request.dropoffLatitude, longitude: request.dropoffLongitude, confirmedAt: request.dropoffConfirmedAt };
    if (location.latitude === null || location.longitude === null || !location.confirmedAt) {
      throw new ShuttleServiceError("지도에서 확인된 위치가 필요합니다.", 409, "LOCATION_NOT_CONFIRMED");
    }
    const duplicate = await tx.shuttleRoutePassenger.findFirst({
      where: {
        shuttleRequestId,
        routePlan: {
          seasonId: route.seasonId,
          direction: route.direction,
          serviceDate: route.serviceDate,
          status: { not: ShuttleRoutePlanStatus.ARCHIVED },
        },
      },
    });
    if (duplicate) throw new ShuttleServiceError("이미 같은 운행 조건의 노선에 배정된 학생입니다.", 409, "DUPLICATE_ASSIGNMENT");
    if (route.vehicleId) {
      const vehicle = await ensureVehicle(tx, route.vehicleId);
      const count = await tx.shuttleRoutePassenger.count({ where: { routePlanId: routeId } });
      contract(() => assertShuttleCapacity(vehicle.capacity, count + 1));
    }
    let stop;
    const stopId = text(stopInput.id, 100);
    if (stopId) {
      stop = await tx.shuttleRouteStop.findFirst({ where: { id: stopId, routePlanId: routeId } });
      if (!stop) throw new ShuttleServiceError("정류장을 찾을 수 없습니다.", 404, "STOP_NOT_FOUND");
    } else {
      const last = await tx.shuttleRouteStop.aggregate({ where: { routePlanId: routeId }, _max: { stopOrder: true } });
      stop = await tx.shuttleRouteStop.create({
        data: {
          routePlanId: routeId,
          stopOrder: (last._max.stopOrder ?? 0) + 1,
          name: text(stopInput.name, 150) || location.name || location.address || "승하차 지점",
          address: text(stopInput.address, 300) || location.address || location.roadAddress || "주소 미입력",
          roadAddress: text(stopInput.roadAddress, 300) || location.roadAddress,
          latitude: stopInput.latitude === undefined && stopInput.lat === undefined ? location.latitude : coordinate(stopInput.latitude ?? stopInput.lat, "정류장", -90, 90),
          longitude: stopInput.longitude === undefined && stopInput.lng === undefined ? location.longitude : coordinate(stopInput.longitude ?? stopInput.lng, "정류장", -180, 180),
          plannedAt: plannedDate(stopInput.plannedAt, route.serviceDate),
          note: text(stopInput.note, 1000),
        },
      });
    }
    const passenger = await tx.shuttleRoutePassenger.create({
      data: {
        routePlanId: routeId,
        stopId: stop.id,
        shuttleRequestId,
        studentNameSnapshot: request.application.childName,
        parentNameSnapshot: request.application.parentName,
        parentPhoneSnapshot: request.application.parentPhone,
        note: text(input.note, 1000) || request.note,
      },
    });
    await syncLegacyAssignment(tx, shuttleRequestId, routeId);
    await audit(tx, actor, "PASSENGER_ASSIGNED", { routePlanId: routeId, shuttleRequestId }, undefined, passenger);
    return tx.shuttleRoutePlan.findUniqueOrThrow({ where: { id: routeId }, include: routeInclude });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function unassignPassenger(actor: Actor, routeId: string, input: Record<string, unknown>) {
  const shuttleRequestId = text(input.shuttleRequestId, 100);
  const passengerId = text(input.passengerId, 100);
  if (!shuttleRequestId && !passengerId) throw new ShuttleServiceError("배정 해제할 학생을 선택해 주세요.");
  return prisma.$transaction(async (tx) => {
    await draftRoute(tx, routeId);
    const passenger = shuttleRequestId
      ? await tx.shuttleRoutePassenger.findUnique({ where: { routePlanId_shuttleRequestId: { routePlanId: routeId, shuttleRequestId } } })
      : await tx.shuttleRoutePassenger.findFirst({ where: { id: passengerId, routePlanId: routeId } });
    if (!passenger) throw new ShuttleServiceError("배정 정보를 찾을 수 없습니다.", 404, "ASSIGNMENT_NOT_FOUND");
    await tx.shuttleRoutePassenger.delete({ where: { id: passenger.id } });
    await syncLegacyAssignment(tx, passenger.shuttleRequestId);
    const remaining = await tx.shuttleRoutePassenger.count({ where: { stopId: passenger.stopId } });
    if (remaining === 0) await tx.shuttleRouteStop.delete({ where: { id: passenger.stopId } });
    await audit(tx, actor, "PASSENGER_UNASSIGNED", { routePlanId: routeId, shuttleRequestId: passenger.shuttleRequestId }, passenger, undefined);
    return tx.shuttleRoutePlan.findUniqueOrThrow({ where: { id: routeId }, include: routeInclude });
  });
}

export async function reorderStops(actor: Actor, routeId: string, input: Record<string, unknown>) {
  const rows = Array.isArray(input.stops) ? input.stops : [];
  if (!rows.length) throw new ShuttleServiceError("정류장 순서를 입력해 주세요.");
  return prisma.$transaction(async (tx) => {
    const before = await draftRoute(tx, routeId);
    const parsed = rows.map((row, index) => {
      if (!row || typeof row !== "object") throw new ShuttleServiceError("정류장 순서를 확인해 주세요.");
      const item = row as Record<string, unknown>;
      const id = text(item.id, 100);
      if (!id) throw new ShuttleServiceError("정류장 ID가 필요합니다.");
      return { id, stopOrder: item.stopOrder === undefined ? index + 1 : integer(item.stopOrder, "정류장 순서", 1), plannedAt: item.plannedAt === undefined ? undefined : plannedDate(item.plannedAt, before.serviceDate) };
    });
    if (new Set(parsed.map((row) => row.id)).size !== parsed.length) {
      throw new ShuttleServiceError("정류장 또는 순서가 중복되었습니다.", 409, "DUPLICATE_STOP_ORDER");
    }
    contract(() => assertUniqueStopOrders(parsed));
    const existing = await tx.shuttleRouteStop.findMany({ where: { routePlanId: routeId }, select: { id: true } });
    if (existing.length !== parsed.length || existing.some((row) => !parsed.some((item) => item.id === row.id))) {
      throw new ShuttleServiceError("노선의 전체 정류장 순서를 보내 주세요.", 409, "STOP_SET_MISMATCH");
    }
    const maximumOrder = existing.length
      ? await tx.shuttleRouteStop.aggregate({ where: { routePlanId: routeId }, _max: { stopOrder: true } })
      : { _max: { stopOrder: 0 } };
    const temporaryOffset = maximumOrder._max.stopOrder ?? 0;
    for (const [index, row] of parsed.entries()) {
      await tx.shuttleRouteStop.update({ where: { id: row.id }, data: { stopOrder: temporaryOffset + index + 1 } });
    }
    for (const row of parsed) {
      await tx.shuttleRouteStop.update({ where: { id: row.id }, data: { stopOrder: row.stopOrder, ...(row.plannedAt !== undefined ? { plannedAt: row.plannedAt } : {}) } });
    }
    const route = await tx.shuttleRoutePlan.findUniqueOrThrow({ where: { id: routeId }, include: routeInclude });
    await audit(tx, actor, "STOPS_REORDERED", { routePlanId: routeId }, before.stops, route.stops);
    return route;
  });
}

export async function confirmRoute(actor: Actor, routeId: string) {
  const route = await prisma.$transaction(async (tx) => {
    const before = await draftRoute(tx, routeId);
    if (!before.vehicleId) throw new ShuttleServiceError("노선을 확정하려면 차량을 배정해 주세요.", 409, "VEHICLE_REQUIRED");
    if (!before.driverUserId) throw new ShuttleServiceError("노선을 확정하려면 셔틀 기사를 배정해 주세요.", 409, "DRIVER_REQUIRED");
    const vehicle = await ensureVehicle(tx, before.vehicleId);
    const passengerCount = before.stops.reduce((sum, stop) => sum + stop.passengers.length, 0);
    if (!passengerCount) throw new ShuttleServiceError("한 명 이상의 학생을 배정해 주세요.", 409, "PASSENGER_REQUIRED");
    contract(() => assertShuttleCapacity(vehicle.capacity, passengerCount));
    const previousPassengerRows = await tx.shuttleRoutePassenger.findMany({
      where: { routePlan: { routeKey: before.routeKey, id: { not: routeId }, status: ShuttleRoutePlanStatus.CONFIRMED } },
      select: { shuttleRequestId: true },
    });
    // 같은 routeKey의 이전 확정본은 보관 처리해 실제 운행 기준을 항상 한 버전으로 유지한다.
    await tx.shuttleRoutePlan.updateMany({
      where: { routeKey: before.routeKey, id: { not: routeId }, status: ShuttleRoutePlanStatus.CONFIRMED },
      data: { status: ShuttleRoutePlanStatus.ARCHIVED },
    });
    const route = await tx.shuttleRoutePlan.update({ where: { id: routeId }, data: { status: ShuttleRoutePlanStatus.CONFIRMED, confirmedAt: new Date(), confirmedByUserId: actor.appUserId }, include: routeInclude });
    const currentRequestIds = new Set(route.stops.flatMap((stop) => stop.passengers.map((passenger) => passenger.shuttleRequestId).filter(Boolean)));
    const affectedRequestIds = new Set([...previousPassengerRows.map((row) => row.shuttleRequestId).filter(Boolean), ...currentRequestIds]);
    for (const shuttleRequestId of affectedRequestIds) {
      await syncLegacyAssignment(tx, shuttleRequestId, currentRequestIds.has(shuttleRequestId) ? route.id : undefined);
    }
    await audit(tx, actor, "ROUTE_CONFIRMED", { routePlanId: routeId }, before, route);
    return route;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  await notifyShuttleRouteConfirmed(route.id);
  return route;
}

export async function archiveRoute(actor: Actor, routeId: string) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.shuttleRoutePlan.findUnique({ where: { id: routeId }, include: routeInclude });
    if (!before) throw new ShuttleServiceError("노선을 찾을 수 없습니다.", 404, "ROUTE_NOT_FOUND");
    const route = await tx.shuttleRoutePlan.update({ where: { id: routeId }, data: { status: ShuttleRoutePlanStatus.ARCHIVED }, include: routeInclude });
    const requestIds = new Set(before.stops.flatMap((stop) => stop.passengers.map((passenger) => passenger.shuttleRequestId).filter(Boolean)));
    for (const shuttleRequestId of requestIds) await syncLegacyAssignment(tx, shuttleRequestId);
    await audit(tx, actor, "ROUTE_ARCHIVED", { routePlanId: routeId }, before, route);
    return route;
  });
}

export async function completeRoute(actor: Actor, routeId: string) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.shuttleRoutePlan.findUnique({ where: { id: routeId }, include: routeInclude });
    if (!before) throw new ShuttleServiceError("노선을 찾을 수 없습니다.", 404, "ROUTE_NOT_FOUND");
    if (before.status !== ShuttleRoutePlanStatus.CONFIRMED) {
      throw new ShuttleServiceError("확정된 운행 노선만 완료 처리할 수 있습니다.", 409, "ROUTE_NOT_CONFIRMED");
    }
    const pendingPassengers = before.stops.reduce((sum, stop) => sum + stop.passengers.filter((passenger) => passenger.rideStatus === "PENDING").length, 0);
    if (pendingPassengers > 0) {
      throw new ShuttleServiceError("체크 대기 학생이 남아 있어 운행을 완료할 수 없습니다.", 409, "RIDE_STATUS_PENDING");
    }
    const route = await tx.shuttleRoutePlan.update({
      where: { id: routeId },
      data: { status: ShuttleRoutePlanStatus.COMPLETED, completedAt: new Date(), completedByUserId: actor.appUserId },
      include: routeInclude,
    });
    await audit(tx, actor, "ROUTE_COMPLETED", { routePlanId: routeId }, before, route);
    return route;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function reviseRoute(actor: Actor, routeId: string) {
  return prisma.$transaction(async (tx) => {
    const source = await tx.shuttleRoutePlan.findUnique({ where: { id: routeId }, include: routeInclude });
    if (!source) throw new ShuttleServiceError("노선을 찾을 수 없습니다.", 404, "ROUTE_NOT_FOUND");
    if (source.status !== ShuttleRoutePlanStatus.CONFIRMED) throw new ShuttleServiceError("확정된 노선만 수정본을 만들 수 있습니다.", 409, "ROUTE_NOT_CONFIRMED");
    const existingDraft = await tx.shuttleRoutePlan.findFirst({
      where: { routeKey: source.routeKey, status: ShuttleRoutePlanStatus.DRAFT },
      orderBy: { version: "desc" },
      include: routeInclude,
    });
    if (existingDraft) return existingDraft;
    const latest = await tx.shuttleRoutePlan.aggregate({ where: { routeKey: source.routeKey }, _max: { version: true } });
    const draft = await tx.shuttleRoutePlan.create({
      data: {
        seasonId: source.seasonId, vehicleId: source.vehicleId, driverUserId: source.driverUserId, routeKey: source.routeKey, version: (latest._max.version ?? source.version) + 1,
        name: source.name, direction: source.direction, serviceDate: source.serviceDate,
        originName: source.originName, originAddress: source.originAddress, originLatitude: source.originLatitude, originLongitude: source.originLongitude,
        destinationName: source.destinationName, destinationAddress: source.destinationAddress, destinationLatitude: source.destinationLatitude, destinationLongitude: source.destinationLongitude,
        previousVersionId: source.id,
      },
    });
    for (const sourceStop of source.stops) {
      const stop = await tx.shuttleRouteStop.create({
        data: {
          routePlanId: draft.id, stopOrder: sourceStop.stopOrder, name: sourceStop.name, address: sourceStop.address,
          roadAddress: sourceStop.roadAddress, latitude: sourceStop.latitude, longitude: sourceStop.longitude,
          plannedAt: sourceStop.plannedAt, note: sourceStop.note,
        },
      });
      if (sourceStop.passengers.length) {
        await tx.shuttleRoutePassenger.createMany({
          data: sourceStop.passengers.map((passenger) => {
            const regularPassenger = passenger as unknown as {
              sourceType?: string | null;
              studentId?: string | null;
              sessionId?: string | null;
              locationKind?: string | null;
            };
            return {
              routePlanId: draft.id, stopId: stop.id, shuttleRequestId: passenger.shuttleRequestId,
              sourceType: regularPassenger.sourceType, studentId: regularPassenger.studentId, sessionId: regularPassenger.sessionId,
              locationKind: regularPassenger.locationKind,
              studentNameSnapshot: passenger.studentNameSnapshot, parentNameSnapshot: passenger.parentNameSnapshot,
              parentPhoneSnapshot: passenger.parentPhoneSnapshot, note: passenger.note,
            } as unknown as Prisma.ShuttleRoutePassengerCreateManyInput;
          }),
        });
      }
    }
    const route = await tx.shuttleRoutePlan.findUniqueOrThrow({ where: { id: draft.id }, include: routeInclude });
    for (const shuttleRequestId of new Set(source.stops.flatMap((stop) => stop.passengers.map((passenger) => passenger.shuttleRequestId).filter(Boolean)))) {
      await syncLegacyAssignment(tx, shuttleRequestId);
    }
    await audit(tx, actor, "ROUTE_REVISION_CREATED", { routePlanId: route.id }, source, route);
    return route;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

function koreaDateOnly(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export async function getStaffShuttleDashboard(actor: StaffActor) {
  const todayKey = koreaDateOnly();
  const today = new Date(`${todayKey}T00:00:00.000Z`);
  // 관리자가 아니면 본인에게 배정된 노선만 본다(예전: DRIVER 일 때만 좁혔다 — 같은 결과).
  const isDriver = actorShuttleScope(actor) !== "ALL";
  const routes = await prisma.shuttleRoutePlan.findMany({
    where: {
      status: ShuttleRoutePlanStatus.CONFIRMED,
      ...(isDriver ? { driverUserId: actor.appUserId } : {}),
      OR: [{ serviceDate: null }, { serviceDate: { gte: today } }],
    },
    orderBy: [{ serviceDate: "asc" }, { direction: "asc" }, { name: "asc" }],
    take: 12,
    include: routeInclude,
  });

  return {
    todayKey,
    routes: routes.map((route) => ({
      ...presentRoute(route),
      passengerCount: route.stops.reduce((sum, stop) => sum + stop.passengers.length, 0),
    })),
  };
}

function parseRideStatus(value: unknown): ShuttleRideStatus {
  if (typeof value !== "string" || !SHUTTLE_RIDE_STATUSES.has(value as ShuttleRideStatus)) {
    throw new ShuttleServiceError("탑승 상태를 확인해 주세요.", 400, "INVALID_RIDE_STATUS");
  }
  return value as ShuttleRideStatus;
}

function assertRideStatusMatchesDirection(direction: ShuttleRouteDirection, status: ShuttleRideStatus) {
  if (status === "PENDING" || status === "NO_SHOW") return;
  if (direction === ShuttleRouteDirection.PICKUP && status !== "BOARDED") {
    throw new ShuttleServiceError("등원 노선에서는 탑승 상태만 처리할 수 있습니다.", 400, "INVALID_PICKUP_STATUS");
  }
  if (direction === ShuttleRouteDirection.DROPOFF && status !== "DROPPED_OFF") {
    throw new ShuttleServiceError("하원 노선에서는 하차 상태만 처리할 수 있습니다.", 400, "INVALID_DROPOFF_STATUS");
  }
}

export async function updatePassengerRideStatus(actor: StaffActor, routeId: string, passengerId: string, statusValue: unknown) {
  const status = parseRideStatus(statusValue);
  const result = await prisma.$transaction(async (tx) => {
    const route = await tx.shuttleRoutePlan.findUnique({
      where: { id: routeId },
      select: { id: true, driverUserId: true, direction: true, status: true, serviceDate: true },
    });
    if (!route || route.status !== ShuttleRoutePlanStatus.CONFIRMED) {
      throw new ShuttleServiceError("확정된 운행 노선만 체크할 수 있습니다.", 404, "CONFIRMED_ROUTE_NOT_FOUND");
    }
    const scope = actorShuttleScope(actor);
    // 순서가 중요하다: 셔틀 권한이 아예 없는 사람(선생님만)을 먼저 막고, 기사님은 본인 노선만.
    if (scope === "NONE") {
      throw new ShuttleServiceError("셔틀 체크 권한이 없습니다.", 403, "SHUTTLE_CHECK_FORBIDDEN");
    }
    if (scope === "OWN" && route.driverUserId !== actor.appUserId) {
      throw new ShuttleServiceError("담당 기사에게 배정된 노선만 체크할 수 있습니다.", 403, "DRIVER_ROUTE_FORBIDDEN");
    }
    if (!route.serviceDate || Number.isNaN(route.serviceDate.getTime()) || koreaDateOnly(route.serviceDate) !== koreaDateOnly()) {
      throw new ShuttleServiceError("탑승 상태는 운행 당일에만 처리할 수 있습니다.", 409, "SHUTTLE_RIDE_STATUS_NOT_SERVICE_DATE");
    }
    assertRideStatusMatchesDirection(route.direction, status);
    const before = await tx.shuttleRoutePassenger.findFirst({ where: { id: passengerId, routePlanId: routeId } });
    if (!before) throw new ShuttleServiceError("탑승 학생을 찾을 수 없습니다.", 404, "PASSENGER_NOT_FOUND");
    const passenger = await tx.shuttleRoutePassenger.update({
      where: { id: passengerId },
      data: {
        rideStatus: status,
        rideStatusUpdatedAt: status === "PENDING" ? null : new Date(),
        rideStatusUpdatedByUserId: status === "PENDING" ? null : actor.appUserId,
      },
    });
    await audit(tx, actor, "PASSENGER_RIDE_STATUS_UPDATED", { routePlanId: routeId, shuttleRequestId: passenger.shuttleRequestId }, before, passenger);
    return { passenger, shouldNotifyNoShow: before.rideStatus !== "NO_SHOW" && status === "NO_SHOW" };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (result.shouldNotifyNoShow) await notifyShuttlePassengerNoShow(routeId, passengerId);
  return result.passenger;
}
