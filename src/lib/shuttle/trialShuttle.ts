import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { kstDow, todayKst } from "@/lib/datetime/kst";
import { deliverOperationalNotification } from "@/lib/operational-notification-delivery";
import { pickServiceMonthFor } from "@/lib/regular/serviceMonth";
import { getSettings } from "@/lib/seasonal/shuttle-optimize";
import { isKoreanCoordinate } from "./academyLocation";
import { getRegularShuttleMonths, getRegularShuttleStops } from "./regularImport";
import type { GeoPoint } from "./regularRosterPlacementLogic";
import { pickTrialClassTime, trialRunOptions, type TrialRunOption } from "./trialShuttlePlacement";
// 휴무 판정 — 기사님 운행표의 «오늘은 휴무»와 같은 함수(연간일정)
import { loadRegularRunPlan } from "./regularRunDay";
import { regularRunHoliday } from "./regularRunDayRules";
import {
  buildTrialShuttleCancelNotice,
  buildTrialShuttleDriverNotice,
  buildTrialShuttleParentSms,
  canReleaseConvertedTrialShuttle,
  isTrialLeadClosedForShuttle,
  normalizeTrialShuttleStatus,
  parseTrialAssignLegs,
  requestedTrialPlace,
  shuttleStatusAfterRelease,
  trialRideOnRunSheet,
  trialShuttleAssignGate,
  trialShuttleRequestStamp,
  TRIAL_SHUTTLE_ASSIGNED_TYPE,
  TRIAL_SHUTTLE_CANCELLED_TYPE,
  type TrialRideDirection,
  type TrialShuttleDirection,
  type TrialShuttlePlace,
  type TrialShuttleReleaseReason,
  type TrialShuttleStatus,
} from "./trialShuttleRules";
import type { TrialRideInput } from "./unifiedDriverRunLogic";

// 체험 셔틀 서버(2026-11-19 원장 결정) — 체험 학생을 «체험 날 하루만» 셔틀에 태운다.
//
// 출처: TrialLead 의 셔틀 요청 칸 + 하루 탑승 표 TrialShuttleRide(마이그레이션 20261119100000).
// ⚠️ 정규 명단(RegularShuttleStop)에 넣지 않는다 — 매주 반복되고, 이름만 있는 줄은 청구 자동 발행을 멈춘다.
//    체험 셔틀은 무료라 청구(Payment)와 이어지는 쓰기가 이 파일에 하나도 없다.
// ⚠️ PgBouncer 트랜잭션 모드 → $queryRawUnsafe / $executeRawUnsafe 만 쓴다(ORM 기본 메서드 금지).
// ⚠️ 날짜: TrialLead.scheduledDate 는 timestamptz → AT TIME ZONE 'Asia/Seoul' 을 «한 번» 건다. 하루 탑승의 날짜는 'YYYY-MM-DD' 문자열.
// ⚠️ 마이그레이션 적용 전(칸·표 없음)에도 운행표·체험 화면이 죽지 않게, 읽기는 «없음»으로 넘어간다.

/** 화면에 그대로 보일 안내를 담는 오류(상태 코드 포함). */
export class TrialShuttleError extends Error {
  constructor(message: string, public status: number = 400, public code: string = "TRIAL_SHUTTLE") {
    super(message);
    this.name = "TrialShuttleError";
  }
}

/** 칸·표가 아직 없는 오류인가(배포 순서가 어긋나 마이그레이션보다 코드가 먼저 나간 경우). */
export function isTrialShuttleSchemaMissing(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: { code?: unknown; message?: unknown }; message?: unknown } | null;
  const text = `${String(e?.code ?? "")} ${String(e?.meta?.code ?? "")} ${String(e?.meta?.message ?? "")} ${String(e?.message ?? "")}`;
  return /42703|42P01|does not exist/i.test(text) && /shuttle|TrialShuttleRide/i.test(text);
}

const NOT_READY_MESSAGE = "체험 셔틀 기능을 준비 중입니다. 잠시 뒤 다시 열어 주세요.";

// 기사 역할 조건 — 명단 변경 기사님 알림(regularRosterNotify)·기사 새 학생 배정 권한과 같다(주 역할 또는 승인된 추가 역할, 탈퇴 제외).
const DRIVER_CONDITION = `(u.role::text='DRIVER' OR EXISTS (SELECT 1 FROM "UserRoleGrant" g WHERE g."userId"=u.id AND g.role='DRIVER' AND g.status='ACTIVE'))`;

// ── 기사님 운행표 ─────────────────────────────────────────────────

/**
 * 그날 체험 셔틀 하루 탑승(운행표 조립 buildUnifiedRun 의 trial 입력).
 * 내보낼지는 순수 판정(trialRideOnRunSheet) 한 곳이 정한다 — 살아 있는 줄(ACTIVE)이어도
 *   ① 체험이 취소·이탈됐거나 ② 배정 상태가 ASSIGNED 가 아니거나 ③ 체험 날짜가 바뀌었거나 ④ 지난 날짜면 내보내지 않는다.
 *   등록 전환(CONVERTED)은 내보낸다 — 체험 당일 등록해도 그날 하원 줄이 남아야 한다.
 * 일정 변경 때 «배정 풀기» 호출이 빠져도 기사님이 엉뚱한 날 아이를 찾으러 가지 않는다.
 * 실패하면 빈 목록(정규·특강 운행표가 같이 죽으면 안 된다).
 * todayYmd 는 테스트가 날짜를 고정하려고 넘긴다(평소엔 오늘 KST).
 */
export async function loadTrialRidesForDate(date: string, todayYmd: string = todayKst()): Promise<TrialRideInput[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  // 지난 날짜는 조회하지도 않는다(체험은 «하루만» — 등록하지 않은 아이의 이름·전화를 과거 날짜로 넘겨 보지 못하게)
  if (date < todayYmd) return [];
  try {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT r.id, r.direction, r."classTime", r."afterStopName", r."sortOrder", r."stopName", r."arriveTime", r.latitude, r.longitude,
              l."childName", l."childGrade", l."parentPhone", l.status AS "leadStatus", l."shuttleStatus",
              to_char(l."scheduledDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "scheduledYmd"
         FROM "TrialShuttleRide" r
         JOIN "TrialLead" l ON l.id = r."trialLeadId"
        WHERE r."serviceDate" = $1 AND r.status = 'ACTIVE'
        ORDER BY r."sortOrder" ASC, r."createdAt" ASC, r.id ASC`,
      date,
    );
    const visible = rows.filter((r) => trialRideOnRunSheet({
      leadStatus: r.leadStatus == null ? null : String(r.leadStatus),
      shuttleStatus: r.shuttleStatus,
      serviceDate: date,
      scheduledYmd: r.scheduledYmd == null ? null : String(r.scheduledYmd),
      todayYmd,
    }));
    return visible.map((r) => ({
      rideId: String(r.id),
      direction: r.direction === "ALIGHT" ? "ALIGHT" : "BOARD",
      classTime: String(r.classTime ?? ""),
      afterStopName: r.afterStopName == null ? null : String(r.afterStopName),
      sortOrder: Number(r.sortOrder) || 0,
      stopName: String(r.stopName ?? ""),
      arriveTime: r.arriveTime == null ? null : String(r.arriveTime),
      lat: r.latitude == null ? null : Number(r.latitude),
      lng: r.longitude == null ? null : Number(r.longitude),
      childName: String(r.childName ?? ""),
      grade: r.childGrade == null ? null : String(r.childGrade),
      parentPhone: r.parentPhone == null ? null : String(r.parentPhone),
    }));
  } catch (error) {
    if (!isTrialShuttleSchemaMissing(error)) console.error("[trial-shuttle] 그날 체험 탑승 조회 실패 — 체험 줄 없이 표시", error);
    return [];
  }
}

const TRIAL_BOARDING_DIRECTION = "TRIAL";

/**
 * 체험 줄의 탑승 체크 저장 — 기존 ShuttleBoarding 에 direction='TRIAL', shuttleRequestId=하루 탑승 id.
 * 그날 운행표에 실제로 나오는 줄(위 loadTrialRidesForDate 와 같은 조건)만 받는다. 없으면 notFound.
 */
export async function setTrialBoarding(input: {
  date: string; rideId: string; status: "BOARDED" | "NOSHOW" | "SELF" | null; via?: "driver" | "teacher";
}): Promise<{ ok: true } | { ok: false; notFound: true }> {
  const rideId = typeof input.rideId === "string" ? input.rideId.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !rideId) throw new Error("요청 형식이 올바르지 않습니다.");
  const rides = await loadTrialRidesForDate(input.date);
  const ride = rides.find((r) => r.rideId === rideId);
  if (input.status == null) {
    // «대기로 되돌리기»는 줄이 풀린 뒤에도 받는다(남은 기록을 지울 수 있게)
    await prisma.$executeRawUnsafe(
      `DELETE FROM "ShuttleBoarding" WHERE "serviceDate" = $1 AND "direction" = $2 AND "shuttleRequestId" = $3`,
      input.date, TRIAL_BOARDING_DIRECTION, rideId,
    );
    return { ok: true };
  }
  if (!ride) return { ok: false, notFound: true };
  const status = input.status === "NOSHOW" ? "NOSHOW" : input.status === "SELF" ? "SELF" : "BOARDED";
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ShuttleBoarding" ("serviceDate","direction","shuttleRequestId","studentName","status","checkedVia","checkedAt")
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT ("serviceDate","direction","shuttleRequestId") DO UPDATE SET
       "status" = EXCLUDED."status", "studentName" = COALESCE(EXCLUDED."studentName", "ShuttleBoarding"."studentName"),
       "checkedVia" = EXCLUDED."checkedVia", "checkedAt" = now()`,
    input.date, TRIAL_BOARDING_DIRECTION, rideId, ride.childName || null, status, input.via === "teacher" ? "teacher" : "driver",
  );
  return { ok: true };
}

// ── 대기 건수 ─────────────────────────────────────────────────────

/**
 * «체험 셔틀 배정 대기 N건» — 요청이 대기(REQUESTED)이고 신청이 살아 있으며 체험 날짜가 지나지 않은 건.
 * 날짜 미정인 요청도 센다(일정을 잡으면 바로 배정해야 하므로). 실패·칸 없음이면 0.
 * withinDays 를 주면 «오늘부터 그 날수 안에 체험이 있는» 건만 센다(아침 요약 알림용 — 1 = 오늘·내일).
 */
export async function countTrialShuttleWaiting(options: { withinDays?: number } = {}): Promise<number> {
  const within = Number.isInteger(options.withinDays) && (options.withinDays as number) >= 0 ? (options.withinDays as number) : null;
  try {
    const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n
         FROM "TrialLead" l
        WHERE l."shuttleStatus" = 'REQUESTED'
          AND l.status NOT IN ('CANCELLED','LOST','CONVERTED','ATTENDED')
          AND (
            ($1::int IS NULL AND (l."scheduledDate" IS NULL
              OR (l."scheduledDate" AT TIME ZONE 'Asia/Seoul')::date >= (NOW() AT TIME ZONE 'Asia/Seoul')::date))
            OR ($1::int IS NOT NULL AND l."scheduledDate" IS NOT NULL
              AND (l."scheduledDate" AT TIME ZONE 'Asia/Seoul')::date
                  BETWEEN (NOW() AT TIME ZONE 'Asia/Seoul')::date AND (NOW() AT TIME ZONE 'Asia/Seoul')::date + $1::int)
          )`,
      within,
    );
    return Number(rows[0]?.n ?? 0);
  } catch (error) {
    if (!isTrialShuttleSchemaMissing(error)) console.error("[trial-shuttle] 배정 대기 건수 조회 실패", error);
    return 0;
  }
}

// ── 배정 패널 ─────────────────────────────────────────────────────

type LeadRow = {
  id: string; childName: string; childGrade: string | null; parentPhone: string | null; status: string;
  shuttleNeeded: boolean; shuttleDirection: TrialShuttleDirection | null; shuttleStatus: TrialShuttleStatus; shuttleAdminNote: string | null;
  pickup: TrialShuttlePlace; dropoff: TrialShuttlePlace;
  scheduledYmd: string | null; scheduledHm: string | null;
  className: string | null; classStart: string | null; classEnd: string | null;
  /** 요청 내용 도장(방향·위치) — 배정 화면을 연 뒤 요청이 바뀌었는지 대조한다 */
  requestStamp: string;
};

type Reader = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };

const LEAD_SELECT = `SELECT l.id, l."childName", l."childGrade", l."parentPhone", l.status,
        l."shuttleNeeded", l."shuttleDirection", l."shuttleStatus", l."shuttleAdminNote",
        l."shuttlePickupName", l."shuttlePickupAddress", l."shuttlePickupLat", l."shuttlePickupLng",
        l."shuttleDropoffName", l."shuttleDropoffAddress", l."shuttleDropoffLat", l."shuttleDropoffLng",
        to_char(l."scheduledDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "scheduledYmd",
        to_char(l."scheduledDate" AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS "scheduledHm",
        c.name AS "className", c."startTime" AS "classStart", c."endTime" AS "classEnd"
   FROM "TrialLead" l
   LEFT JOIN "Class" c ON c.id = l."scheduledClassId"
  WHERE l.id = $1`;

async function readLead(db: Reader, leadId: string, forUpdate = false): Promise<LeadRow | null> {
  const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(`${LEAD_SELECT}${forUpdate ? " FOR UPDATE OF l" : ""}`, leadId);
  const r = rows[0];
  if (!r) return null;
  const direction = r.shuttleDirection === "BOTH" || r.shuttleDirection === "PICKUP" || r.shuttleDirection === "DROPOFF" ? r.shuttleDirection : null;
  return {
    id: String(r.id),
    childName: String(r.childName ?? ""),
    childGrade: r.childGrade == null ? null : String(r.childGrade),
    parentPhone: r.parentPhone == null ? null : String(r.parentPhone),
    status: String(r.status ?? ""),
    shuttleNeeded: r.shuttleNeeded === true,
    shuttleDirection: direction,
    shuttleStatus: normalizeTrialShuttleStatus(r.shuttleStatus),
    shuttleAdminNote: r.shuttleAdminNote == null ? null : String(r.shuttleAdminNote),
    pickup: requestedTrialPlace(r as never, "BOARD"),
    dropoff: requestedTrialPlace(r as never, "ALIGHT"),
    scheduledYmd: r.scheduledYmd == null ? null : String(r.scheduledYmd),
    scheduledHm: r.scheduledHm == null ? null : String(r.scheduledHm),
    className: r.className == null ? null : String(r.className),
    classStart: r.classStart == null ? null : String(r.classStart),
    classEnd: r.classEnd == null ? null : String(r.classEnd),
    requestStamp: trialShuttleRequestStamp(r as never),
  };
}

export type TrialShuttleRideView = {
  id: string; serviceDate: string; direction: TrialRideDirection; classTime: string; afterStopName: string | null;
  stopName: string; address: string | null; latitude: number | null; longitude: number | null; arriveTime: string;
  driverNotified: boolean; parentSmsSent: boolean;
  /** 배정 내용이 바뀐 횟수 — 기사님 알림 키에 섞는다(X→Y→X 로 되돌려도 알림이 다시 가게) */
  revision: number;
};

async function readActiveRides(db: Reader, leadId: string): Promise<TrialShuttleRideView[]> {
  const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT id, "serviceDate", direction, "classTime", "afterStopName", "stopName", address, latitude, longitude, "arriveTime",
            ("driverNotifiedAt" IS NOT NULL) AS "driverNotified", ("parentSmsSentAt" IS NOT NULL) AS "parentSmsSent", revision
       FROM "TrialShuttleRide" WHERE "trialLeadId" = $1 AND status = 'ACTIVE'
      ORDER BY CASE direction WHEN 'BOARD' THEN 0 ELSE 1 END`,
    leadId,
  );
  return rows.map((r) => ({
    id: String(r.id),
    serviceDate: String(r.serviceDate),
    direction: r.direction === "ALIGHT" ? "ALIGHT" : "BOARD",
    classTime: String(r.classTime ?? ""),
    afterStopName: r.afterStopName == null ? null : String(r.afterStopName),
    stopName: String(r.stopName ?? ""),
    address: r.address == null ? null : String(r.address),
    latitude: r.latitude == null ? null : Number(r.latitude),
    longitude: r.longitude == null ? null : Number(r.longitude),
    arriveTime: String(r.arriveTime ?? ""),
    driverNotified: r.driverNotified === true,
    parentSmsSent: r.parentSmsSent === true,
    revision: Number(r.revision) || 0,
  }));
}

export type TrialShuttlePanelData = {
  /** false = 마이그레이션 적용 전(칸·표 없음) — 패널은 «준비 중»만 보인다 */
  ready: boolean;
  lead: {
    id: string; childName: string; childGrade: string | null; parentPhone: string | null;
    shuttleNeeded: boolean; shuttleDirection: TrialShuttleDirection | null; shuttleStatus: TrialShuttleStatus; shuttleAdminNote: string | null;
    pickup: TrialShuttlePlace; dropoff: TrialShuttlePlace;
    scheduledYmd: string | null; scheduledHm: string | null; className: string | null;
    /** 취소·이탈·등록 전환된 신청 — 패널이 행동 버튼을 숨긴다 */
    closed: boolean;
    /** 요청 내용 도장 — «배정 확정» 때 그대로 돌려보낸다 */
    requestStamp: string;
    /** 닫힌 신청이지만 «배정 풀기» 하나는 남긴다 — 등록 전환 + 살아 있는 줄 + 오늘 이후(서버가 KST 로 판정) */
    canReleaseAfterConvert: boolean;
  } | null;
  /** 지금 배정할 수 있는가(안 되면 이유) */
  gate: { ok: true } | { ok: false; reason: string };
  rides: TrialShuttleRideView[];
  /** 체험 날짜가 확정됐을 때만 — 그 요일 정규 운행 묶음과 미리 고른 묶음 */
  run: {
    weekday: number;
    options: Record<TrialRideDirection, TrialRunOption[]>;
    defaultClassTime: Record<TrialRideDirection, string | null>;
    academy: GeoPoint | null;
    depot: GeoPoint | null;
    /** 체험 날이 연간일정 휴무면 그 이름(패널 경고 한 줄 — 배정을 막지는 않는다). 모르면 null */
    holidayTitle: string | null;
  } | null;
  /** 학부모 문자 «미리 채운» 문구(배정된 뒤에만) */
  smsDraft: string | null;
};

function geoOrNull(point: { lat: number; lng: number } | null | undefined): GeoPoint | null {
  return point && isKoreanCoordinate(point.lat, point.lng) ? { lat: point.lat, lng: point.lng } : null;
}

/** 배정 패널이 처음 읽는 값 전부. 권한 확인은 호출부(API)가 한다. */
export async function getTrialShuttlePanel(leadId: string): Promise<TrialShuttlePanelData> {
  let lead: LeadRow | null;
  let rides: TrialShuttleRideView[];
  try {
    lead = await readLead(prisma, leadId);
    rides = lead ? await readActiveRides(prisma, leadId) : [];
  } catch (error) {
    if (isTrialShuttleSchemaMissing(error)) {
      return { ready: false, lead: null, gate: { ok: false, reason: NOT_READY_MESSAGE }, rides: [], run: null, smsDraft: null };
    }
    throw error;
  }
  if (!lead) throw new TrialShuttleError("체험 신청을 찾지 못했습니다.", 404, "NOT_FOUND");

  const gate = trialShuttleAssignGate({ leadStatus: lead.status, scheduledYmd: lead.scheduledYmd, todayYmd: todayKst() });
  let run: TrialShuttlePanelData["run"] = null;
  if (lead.scheduledYmd) {
    // 그날이 속한 달 «이하»의 최신 명단 달 — 기사님 화면(getRegularDriverDay)과 같은 고르기
    const weekday = kstDow(lead.scheduledYmd);
    const serviceMonth = pickServiceMonthFor(await getRegularShuttleMonths(), lead.scheduledYmd);
    const [{ stops }, settings, plan] = await Promise.all([
      getRegularShuttleStops(serviceMonth),
      getSettings().catch(() => null),
      loadRegularRunPlan().catch(() => null), // 연간일정을 못 읽으면 휴무 경고 없이
    ]);
    const holiday = plan ? regularRunHoliday(lead.scheduledYmd, plan.monthlyDates, plan.events) : null;
    const options = { BOARD: trialRunOptions(stops, weekday, "BOARD"), ALIGHT: trialRunOptions(stops, weekday, "ALIGHT") };
    // 체험 시각 = 확정한 시각(자정이면 시각을 안 정한 것 → 반의 시작 시각)
    const start = lead.scheduledHm && lead.scheduledHm !== "00:00" ? lead.scheduledHm : lead.classStart;
    run = {
      weekday,
      options,
      defaultClassTime: {
        BOARD: pickTrialClassTime({ weekday, start, end: lead.classEnd, options: options.BOARD }),
        ALIGHT: pickTrialClassTime({ weekday, start, end: lead.classEnd, options: options.ALIGHT }),
      },
      academy: geoOrNull(settings?.academy),
      depot: geoOrNull(settings?.depot),
      holidayTitle: holiday ? holiday.title || "휴무" : null,
    };
  }
  const todaysRides = lead.scheduledYmd ? rides.filter((r) => r.serviceDate === lead!.scheduledYmd) : [];
  return {
    ready: true,
    lead: {
      id: lead.id, childName: lead.childName, childGrade: lead.childGrade, parentPhone: lead.parentPhone,
      shuttleNeeded: lead.shuttleNeeded, shuttleDirection: lead.shuttleDirection, shuttleStatus: lead.shuttleStatus, shuttleAdminNote: lead.shuttleAdminNote,
      pickup: lead.pickup, dropoff: lead.dropoff,
      scheduledYmd: lead.scheduledYmd, scheduledHm: lead.scheduledHm, className: lead.className,
      closed: isTrialLeadClosedForShuttle(lead.status),
      requestStamp: lead.requestStamp,
      canReleaseAfterConvert: canReleaseConvertedTrialShuttle({ leadStatus: lead.status, activeRideDates: rides.map((ride) => ride.serviceDate), todayYmd: todayKst() }),
    },
    gate,
    rides,
    run,
    smsDraft: lead.scheduledYmd && todaysRides.length > 0
      ? buildTrialShuttleParentSms({ childName: lead.childName, serviceDate: lead.scheduledYmd, legs: todaysRides })
      : null,
  };
}

// ── 기사님 알림 ───────────────────────────────────────────────────

function shortHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/**
 * 현재 기사 역할 전원에게 앱 알림 + 푸시(운영 알림 전달 장부 — 명단 변경 알림과 같은 길).
 * 실패해도 던지지 않는다(배정·해제 결과를 바꾸지 않는다). 보낸 기사 수를 돌려준다.
 */
async function notifyDrivers(input: { stableEventKey: string; eventType: string; title: string; message: string; linkUrl: string }): Promise<number> {
  try {
    const drivers = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT u.id FROM "User" u WHERE u."withdrawnAt" IS NULL AND ${DRIVER_CONDITION} ORDER BY u.id`,
    );
    let sent = 0;
    for (const driver of drivers) {
      try {
        const result = await deliverOperationalNotification({
          stableEventKey: input.stableEventKey,
          eventType: input.eventType,
          trigger: "TRIAL_SHUTTLE",
          recipientUserId: String(driver.id),
          title: input.title,
          message: input.message,
          linkUrl: input.linkUrl,
        });
        if (result.inAppCreated) sent += 1;
      } catch (error) {
        console.error("[trial-shuttle] 기사님 알림 실패:", error);
      }
    }
    return sent;
  } catch (error) {
    console.error("[trial-shuttle] 기사님 알림 준비 실패:", error);
    return 0;
  }
}

// ── 배정 ─────────────────────────────────────────────────────────

/**
 * 배정 확정 — 방향별 하루 탑승을 만들고(같은 날·같은 방향 줄이 있으면 그 줄을 고친다 → 탑승 체크 키 유지)
 * 상태를 ASSIGNED 로 바꾼 뒤 기사님께 알린다. 권한 확인은 호출부(API — 관리자·부원장)가 한다.
 */
export async function assignTrialShuttle(
  actorUserId: string | null, leadId: string, rawLegs: unknown,
  /** 배정 화면이 열 때 받은 요청 도장 — 주면 지금 요청과 대조한다(다르면 거절) */
  requestStamp?: string | null,
): Promise<{ rides: TrialShuttleRideView[]; driversNotified: number }> {
  const parsed = parseTrialAssignLegs(rawLegs);
  if (!parsed.ok) throw new TrialShuttleError(parsed.error, 400, "INVALID_LEGS");
  const legs = parsed.legs;

  let outcome: { lead: LeadRow; serviceDate: string; dropped: TrialShuttleRideView[] };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      // 같은 신청을 두 사람이 동시에 배정하지 않게 신청 줄을 잠근다
      const lead = await readLead(tx, leadId, true);
      if (!lead) throw new TrialShuttleError("체험 신청을 찾지 못했습니다.", 404, "NOT_FOUND");
      const gate = trialShuttleAssignGate({ leadStatus: lead.status, scheduledYmd: lead.scheduledYmd, todayYmd: todayKst() });
      if (!gate.ok) throw new TrialShuttleError(gate.reason, 409, "NOT_ASSIGNABLE");
      // 화면을 연 뒤 다른 사람이 셔틀 요청(방향·위치)을 고쳤으면 옛 내용으로 배정하지 않는다
      if (typeof requestStamp === "string" && requestStamp && requestStamp !== lead.requestStamp) {
        throw new TrialShuttleError("셔틀 요청 내용이 바뀌었습니다. 바뀐 내용을 확인하고 다시 배정해 주세요.", 409, "REQUEST_CHANGED");
      }
      const serviceDate = lead.scheduledYmd as string;
      const existing = await readActiveRides(tx, leadId);
      const dropped: TrialShuttleRideView[] = [];

      // 이번 배정에 없는 방향·다른 날짜의 살아 있는 줄은 푼다(새 줄을 넣기 전에 — 방향마다 살아 있는 줄은 하나뿐)
      for (const ride of existing) {
        const keep = ride.serviceDate === serviceDate && legs.some((leg) => leg.direction === ride.direction);
        if (keep) continue;
        await tx.$executeRawUnsafe(
          `UPDATE "TrialShuttleRide" SET status='CANCELLED', "cancelReason"='REASSIGNED', "cancelledAt"=NOW(), "updatedAt"=NOW() WHERE id=$1 AND status='ACTIVE'`,
          ride.id,
        );
        // 다시 배정으로 사라지는 방향은 기사님께 «취소»로 알린다(같은 방향을 새 날짜로 넣는 경우는 새 배정 알림이 대신한다)
        if (!legs.some((leg) => leg.direction === ride.direction)) dropped.push(ride);
      }

      for (const leg of legs) {
        const same = existing.find((ride) => ride.serviceDate === serviceDate && ride.direction === leg.direction);
        if (same) {
          // 내용이 바뀌면 알림·문자 표시를 지우고(다시 알려야 한다) 변경 차수(revision)를 올린다. 그대로면 그대로 둔다.
          // revision 은 기사님 알림 키에 섞인다 — X→Y→X 로 되돌려도 «처음 X»와 다른 알림이라 장부가 버리지 않는다.
          await tx.$executeRawUnsafe(
            `UPDATE "TrialShuttleRide" SET
                revision = CASE WHEN ("classTime","afterStopName","stopName","arriveTime") IS NOT DISTINCT FROM ($2::text,$3::text,$4::text,$8::text) THEN revision ELSE revision + 1 END,
                "driverNotifiedAt" = CASE WHEN ("classTime","afterStopName","stopName","arriveTime") IS NOT DISTINCT FROM ($2::text,$3::text,$4::text,$8::text) THEN "driverNotifiedAt" ELSE NULL END,
                "parentSmsSentAt" = CASE WHEN ("stopName","arriveTime") IS NOT DISTINCT FROM ($4::text,$8::text) THEN "parentSmsSentAt" ELSE NULL END,
                "classTime"=$2, "afterStopName"=$3, "stopName"=$4, address=$5, latitude=$6, longitude=$7, "arriveTime"=$8, "updatedAt"=NOW()
              WHERE id=$1`,
            same.id, leg.classTime, leg.afterStopName, leg.stopName, leg.address, leg.latitude, leg.longitude, leg.arriveTime,
          );
        } else {
          await tx.$executeRawUnsafe(
            `INSERT INTO "TrialShuttleRide" ("trialLeadId","serviceDate",direction,"classTime","afterStopName","sortOrder","stopName",address,latitude,longitude,"arriveTime","createdByUserId")
             VALUES ($1,$2,$3,$4,$5,
               (SELECT COALESCE(MAX("sortOrder"), -1) + 1 FROM "TrialShuttleRide" WHERE "serviceDate"=$2 AND status='ACTIVE'),
               $6,$7,$8,$9,$10,$11)`,
            leadId, serviceDate, leg.direction, leg.classTime, leg.afterStopName, leg.stopName, leg.address, leg.latitude, leg.longitude, leg.arriveTime, actorUserId,
          );
        }
      }
      await tx.$executeRawUnsafe(
        `UPDATE "TrialLead" SET "shuttleStatus"='ASSIGNED', "shuttleNeeded"=true, "updatedAt"=NOW() WHERE id=$1`,
        leadId,
      );
      return { lead, serviceDate, dropped };
    });
  } catch (error) {
    if (isTrialShuttleSchemaMissing(error)) throw new TrialShuttleError(NOT_READY_MESSAGE, 503, "NOT_READY");
    throw error;
  }

  // ── 저장이 끝난 뒤 알림(실패해도 배정은 그대로) ──
  const rides = await readActiveRides(prisma, leadId);
  const pending = rides.filter((ride) => !ride.driverNotified);
  let driversNotified = 0;
  if (pending.length > 0) {
    // 알림은 그날 배정 전체를 한 건으로(등원·하원을 따로 보내지 않는다). 같은 내용이면 장부가 한 번만 보낸다.
    const notice = buildTrialShuttleDriverNotice({ childName: outcome.lead.childName, grade: outcome.lead.childGrade, serviceDate: outcome.serviceDate, legs: rides });
    driversNotified = await notifyDrivers({
      // 키 = 줄 id + 변경 차수 — «내용이 실제로 바뀐 배정»마다 새 알림. «같은 내용 다시 확정»은 위 pending 이 비어 여기까지 오지 않는다
      stableEventKey: `trial-shuttle:assigned:${leadId}:${shortHash(rides.map((r) => `${r.id}#${r.revision}`).join(";"))}`,
      eventType: TRIAL_SHUTTLE_ASSIGNED_TYPE,
      ...notice,
    });
    if (driversNotified > 0) {
      await prisma.$executeRawUnsafe(
        `UPDATE "TrialShuttleRide" SET "driverNotifiedAt"=NOW() WHERE id = ANY($1::text[]) AND status='ACTIVE'`,
        rides.map((r) => r.id),
      ).catch((error) => console.error("[trial-shuttle] 알림 시각 기록 실패", error));
    }
  }
  // 다시 배정으로 빠진 방향 — 기사님이 알고 있던(알림을 받은) 오늘·앞날 줄만 «취소»로 알린다
  const droppedKnown = outcome.dropped.filter((ride) => ride.driverNotified && ride.serviceDate >= todayKst());
  if (droppedKnown.length > 0) {
    const notice = buildTrialShuttleCancelNotice({ childName: outcome.lead.childName, grade: outcome.lead.childGrade, serviceDate: droppedKnown[0].serviceDate, directions: droppedKnown.map((r) => r.direction) });
    await notifyDrivers({
      stableEventKey: `trial-shuttle:cancelled:${leadId}:${shortHash(droppedKnown.map((r) => `${r.id}#${r.revision}`).join(","))}`,
      eventType: TRIAL_SHUTTLE_CANCELLED_TYPE,
      ...notice,
    });
  }
  return { rides: await readActiveRides(prisma, leadId), driversNotified };
}

// ── 해제 ─────────────────────────────────────────────────────────

/**
 * 하루 탑승을 풀고 상태를 규칙대로 돌린다(배정됨 → 배정 대기 / «셔틀 어려움»이면 UNAVAILABLE).
 * 기사님께 이미 알린 앞날 배정이면 «취소» 알림을 보낸다. 오류는 던진다(관리자 버튼용).
 */
export async function releaseTrialShuttle(leadId: string, reason: TrialShuttleReleaseReason, options: { adminNote?: string | null } = {}): Promise<{ released: number; driversNotified: number; shuttleStatus: TrialShuttleStatus }> {
  const note = typeof options.adminNote === "string" ? options.adminNote.trim().slice(0, 500) : "";
  const outcome = await prisma.$transaction(async (tx) => {
    const lead = await readLead(tx, leadId, true);
    if (!lead) throw new TrialShuttleError("체험 신청을 찾지 못했습니다.", 404, "NOT_FOUND");
    const rides = await readActiveRides(tx, leadId);
    if (rides.length > 0) {
      await tx.$executeRawUnsafe(
        `UPDATE "TrialShuttleRide" SET status='CANCELLED', "cancelReason"=$2, "cancelledAt"=NOW(), "updatedAt"=NOW() WHERE "trialLeadId"=$1 AND status='ACTIVE'`,
        leadId, reason,
      );
    }
    const next = shuttleStatusAfterRelease(lead.shuttleStatus, reason);
    if (next !== lead.shuttleStatus || (reason === "UNAVAILABLE" && note)) {
      // «셔틀 어려움» 메모는 적었을 때만 바꾼다(빈 값으로 지우지 않는다)
      await tx.$executeRawUnsafe(
        `UPDATE "TrialLead" SET "shuttleStatus"=$2, "shuttleAdminNote"=COALESCE(NULLIF($3::text, ''), "shuttleAdminNote"), "updatedAt"=NOW() WHERE id=$1`,
        leadId, next, reason === "UNAVAILABLE" ? note : "",
      );
    }
    return { lead, rides, next };
  });

  let driversNotified = 0;
  // 기사님이 배정을 알고 있는(알림을 받은) 오늘·앞날 탑승만 «취소»로 알린다 — 지난 날·알린 적 없는 줄은 조용히 푼다
  const known = outcome.rides.filter((ride) => ride.driverNotified && ride.serviceDate >= todayKst());
  if (known.length > 0) {
    const serviceDate = known[0].serviceDate;
    const notice = buildTrialShuttleCancelNotice({ childName: outcome.lead.childName, grade: outcome.lead.childGrade, serviceDate, directions: known.map((r) => r.direction) });
    driversNotified = await notifyDrivers({
      // 풀린 줄은 다시 살아나지 않는다(새 배정은 새 줄) → 줄 기준 키라 같은 해제를 두 번 불러도 알림은 한 번
      stableEventKey: `trial-shuttle:cancelled:${leadId}:${shortHash(known.map((r) => `${r.id}#${r.revision}`).join(","))}`,
      eventType: TRIAL_SHUTTLE_CANCELLED_TYPE,
      ...notice,
    });
  }
  return { released: outcome.rides.length, driversNotified, shuttleStatus: outcome.next };
}

/**
 * 체험 일정 변경·취소·이탈·셔틀 요청 변경 때 부르는 «배정 풀기»(체험 저장 코드가 부른다).
 * **절대 던지지 않는다** — 셔틀 정리 실패가 체험 일정 저장을 막으면 안 된다. 풀린 줄 수와 실패 여부를 돌려준다.
 *   - failed=true : 풀지 못했다(DB 오류 등) — 호출부가 «셔틀 배정을 풀지 못했습니다»를 알려야 한다.
 *   - failed=false: 풀었거나 풀 것이 없었다. 표·칸이 아직 없는 경우(마이그레이션 전)도 풀 것이 없는 것이라 false.
 * 풀 줄이 없으면 아무 일도 하지 않는다(배정 대기·요청 없음 상태는 그대로).
 * 같은 사유로 두 번 불러도 안전하다 — 두 번째는 풀 줄이 없어 상태·알림이 그대로다
 * (요청을 고친 뒤 «한 번 더 풀기»로, 그 사이 다른 관리자가 넣은 배정을 정리할 수 있다).
 * 호출부가 이 함수를 빠뜨려도 기사님 운행표는 «날짜가 바뀐·취소된 체험»의 줄을 내보내지 않는다(loadTrialRidesForDate).
 */
export async function releaseTrialShuttleOnLeadChange(leadId: string, reason: TrialShuttleReleaseReason): Promise<{ released: number; failed: boolean }> {
  try {
    if (typeof leadId !== "string" || !leadId.trim()) return { released: 0, failed: false };
    const result = await releaseTrialShuttle(leadId, reason);
    return { released: result.released, failed: false };
  } catch (error) {
    // 표·칸 없음 = 배정 자체가 있을 수 없다 → 실패가 아니다
    if (isTrialShuttleSchemaMissing(error)) return { released: 0, failed: false };
    // 체험 신청이 없는 것(이미 지워짐)도 풀 것이 없는 것
    if (error instanceof TrialShuttleError && error.code === "NOT_FOUND") return { released: 0, failed: false };
    console.error("[trial-shuttle] 일정 변경에 따른 배정 풀기 실패", leadId, reason, error);
    return { released: 0, failed: true };
  }
}

/** «셔틀 어려움» → 다시 «배정 대기»로(관리자가 마음을 바꿨을 때). 다른 상태에서는 아무 일도 하지 않는다. */
export async function reopenTrialShuttleRequest(leadId: string): Promise<{ shuttleStatus: TrialShuttleStatus }> {
  const rows = await prisma.$queryRawUnsafe<{ shuttleStatus: string }[]>(
    `UPDATE "TrialLead" SET "shuttleStatus"='REQUESTED', "updatedAt"=NOW()
      WHERE id=$1 AND "shuttleStatus"='UNAVAILABLE' RETURNING "shuttleStatus"`,
    leadId,
  );
  if (rows[0]) return { shuttleStatus: "REQUESTED" };
  const lead = await readLead(prisma, leadId);
  if (!lead) throw new TrialShuttleError("체험 신청을 찾지 못했습니다.", 404, "NOT_FOUND");
  return { shuttleStatus: lead.shuttleStatus };
}

/** 학부모 문자를 보낸 뒤 보낸 시각을 남긴다(패널의 «문자 보냄» 표시). 실제 발송은 기존 수동 문자 장치가 한다. */
export async function markTrialShuttleParentSmsSent(leadId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "TrialShuttleRide" SET "parentSmsSentAt"=NOW(), "updatedAt"=NOW() WHERE "trialLeadId"=$1 AND status='ACTIVE'`,
    leadId,
  );
}
