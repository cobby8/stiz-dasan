import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { isRidingShuttleStatus, ridingShuttleStatusSql, seasonalShuttleEligibilitySql } from "./shuttleEligibility";
import { buildConfirmedRosterUpdate, type ConfirmedRosterPatch, type ConfirmedRosterPin } from "./shuttleRosterEdit";
// 확정본 수정에 쓰는 타입은 순수 모듈이 정본이다. 소비처(API·서비스)는 계속 이 파일에서 가져다 쓴다.
export type { ConfirmedRosterPatch, ConfirmedRosterPin } from "./shuttleRosterEdit";

/**
 * 방학특강 셔틀 "확정 명단" 게이트웨이 — 셔틀 대상자를 읽는 **유일한 출구**.
 *
 * 왜 이 파일이 필요한가:
 *   셔틀 대상자는 지금까지 어디에도 저장돼 있지 않았다. 화면마다 신청서·수강항목·개설반·
 *   셔틀신청 4개 테이블을 새로 조인해 걸러야 했고, 새 SQL을 쓸 때마다 필터가 빠졌다.
 *   같은 사고가 2026-07-26 기준 5회 반복됐다(마지막 1회는 이번 작업 중 워킹트리에서 발견).
 *   공용 SQL 조각(shuttleEligibility.ts)은 "새 쿼리가 그걸 안 쓰면" 여전히 뚫린다.
 *   → 원장이 확인해 확정한 명단을 값으로 복제해 저장하고, 모든 화면이 이 파일만 통과하게 한다.
 *
 * 밖으로 내보내는 **조회** 함수는 딱 2개다:
 *   1) getConfirmedShuttleRoster(seasonId?)             — 시즌 확정 명단(누가 셔틀 회원인가)
 *   2) getConfirmedShuttleRosterForDate(date, direction) — 그날 실제로 태울 사람(날짜 × 방향)
 *
 * ⚠️ 폴백(확정본이 없을 때 원본을 조회하는 로직)은 **이 파일 안에만** 있다.
 *    소비처는 폴백의 존재를 몰라야 하고, 원본 테이블을 직접 조회해서도 안 된다.
 *
 * 권한: 조회 함수는 인증을 하지 않는다(학부모 마이페이지도 쓰기 때문).
 *       호출부가 기존 가드(requireAdmin / requireVerifiedParent)를 그대로 유지한다.
 *       확정·수정·제외 함수만 이 파일에서 ADMIN(원장)을 직접 검사한다.
 */

// ────────────────────────────────────────────────────────────────
// 타입
// ────────────────────────────────────────────────────────────────

export type ShuttleRosterSource = "CONFIRMED" | "FALLBACK";

/** 한 사람의 등원/하원 위치 한 벌. 원본 컬럼 이름을 그대로 따라간다(옮겨 담다 흘리는 실수 방지). */
export type ShuttleRosterPlace = {
  location: string | null;
  address: string | null;
  roadAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
  source: string | null;
  accuracyMeters: number | null;
  /** 관리자가 위치를 확인한 시각. 노선 편성 화면의 "이 학생 배차 가능" 판정에 쓰인다(빠뜨리면 배차 버튼이 죽는다). */
  confirmedAt: Date | null;
};

export type ShuttleRosterEntry = {
  /** 확정본에서 나왔는지, 폴백(원본 조회)에서 나왔는지. 소비처는 몰라도 되고 진단용이다. */
  origin: ShuttleRosterSource;
  /** 확정본 행 id. 폴백이면 null. */
  rosterId: string | null;
  seasonId: string;
  shuttleRequestId: string;
  /** 신청서 id. 학생 상세 모달을 여는 키다. */
  applicationId: string | null;
  applicationItemId: string | null;
  /** 전환된 Student.id. 전환 전이면 null(학부모 화면은 이 값이 있어야 자녀와 이어 붙인다). */
  studentId: string | null;

  ride: boolean;

  studentName: string;
  childGrade: string | null;
  childGender: string | null;
  childPhone: string | null;
  parentName: string | null;
  parentPhone: string | null;

  offeringId: string | null;
  offeringTitle: string | null;
  weekdays: string[];
  classStart: string | null; // 'HH:MM' (Asia/Seoul)
  classEnd: string | null;

  pickup: ShuttleRosterPlace;
  /** 학부모가 적어 낸 희망시간. 형식이 제각각이라(참고값) 계산에 쓰지 않는다. */
  pickupTime: string | null;
  dropoff: ShuttleRosterPlace;
  dropoffSameAsPickup: boolean;

  note: string | null;
  /** 신청 접수 시각. 미배정 목록의 기존 정렬(신청순)을 그대로 재현하는 데 쓴다. */
  requestCreatedAt: Date | null;
};

/** 날짜별 운행 명단 1명. 방향에 따라 이미 결정된 위치 한 벌만 들고 있다. */
export type ShuttleRosterRider = ShuttleRosterEntry & {
  serviceDate: string; // 'YYYY-MM-DD'
  /** 그 날짜 수업의 시작/종료 시각. 스냅샷이 아니라 그날 세션 값이다. */
  sessionStart: string | null;
  sessionEnd: string | null;
  /** direction에 맞춰 이미 고른 위치(하원=등원 동일 옵션까지 반영). */
  place: ShuttleRosterPlace;
  placeLabel: string;
  /** 해당 날짜 결석(ABSENT) 또는 사유결석(EXCUSED). includeAbsent:true 로 조회할 때만 세팅된다. */
  isAbsent?: boolean;
};

export type ShuttleRosterDatePlan = {
  origin: ShuttleRosterSource;
  date: string | null;
  direction: "PICKUP" | "DROPOFF";
  /** 운행일 후보(셔틀 대상자가 한 명이라도 등원하는 날짜). */
  availableDates: { date: string; dow: number }[];
  riders: ShuttleRosterRider[];
  classStart: string | null;
  classEnd: string | null;
};

// ────────────────────────────────────────────────────────────────
// 내부 유틸
// ────────────────────────────────────────────────────────────────

/** raw SQL 한 행. 컬럼 이름이 SQL 문자열에 있어 정적 타입을 붙일 수 없다(PgBouncer 때문에 $queryRawUnsafe 고정). */
type RawRow = Record<string, unknown>;

function dt(v: unknown): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t : null;
}

function weekdayList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter(Boolean);
}

/**
 * 킬 스위치 확인. 원장이 재배포 없이 되돌릴 수 있어야 해서 DB에 둔다.
 *   true         → 확정 명단을 쓴다
 *   false / NULL → 끔. 확정본을 무시하고 항상 원본 폴백(= 전환 이전과 완전히 동일한 동작)
 *
 * 기본값이 "꺼짐"인 이유: 아무도 아무것도 안 해도 화면이 오늘과 1도 달라지지 않아야 하기 때문이다.
 * 3단계에서 원장이 확정 버튼을 누르는 순간 켜진다.
 *
 * ⚠️ getAcademySettings()는 unstable_cache(5분)라 킬 스위치로 쓸 수 없다(끄고 5분을 기다릴 수 없다).
 *    그래서 여기서는 캐시를 거치지 않고 직접 읽는다.
 * ⚠️ 문자열('false')로 저장된 환경도 있을 수 있어 boolean·문자열 양쪽을 다 받는다.
 */
async function confirmedModeEnabled(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRawUnsafe<RawRow[]>(
      `SELECT "shuttleRosterConfirmedMode" AS mode FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`,
    );
    const mode = rows[0]?.mode;
    if (mode === true) return true;
    if (typeof mode === "string") return ["TRUE", "ON", "1"].includes(mode.trim().toUpperCase());
    return false;
  } catch {
    // 컬럼이 아직 없는 환경(구버전 DB)에서는 폴백으로 동작한다. 화면이 비는 것보다 안전하다.
    return false;
  }
}

/** 시즌 범위 WHERE 절. seasonId를 주면 그 시즌만, 안 주면 보관되지 않은 시즌 전부. */
function seasonScope(alias: { roster?: string; application?: string; season: string }, seasonId?: string | null) {
  const params: unknown[] = [];
  if (seasonId) {
    params.push(seasonId);
    const col = alias.roster ? `${alias.roster}."seasonId"` : `${alias.application}."seasonId"`;
    return { where: `${col} = $1`, params };
  }
  // '가장 최근 시즌 1개'로 좁히지 않는 이유: 다음 방학 시즌을 미리 만들어 두는 순간
  // 운영 중인 이번 시즌 명단이 기사님 화면에서 통째로 사라진다. 그게 더 큰 사고다.
  return { where: `${alias.season}.status <> 'ARCHIVED'`, params };
}

function place(r: RawRow, prefix: "pickup" | "dropoff"): ShuttleRosterPlace {
  const p = (suffix: string) => r[`${prefix}${suffix}`];
  return {
    location: str(p("Location")),
    address: str(p("Address")),
    roadAddress: str(p("RoadAddress")),
    latitude: num(p("Latitude")),
    longitude: num(p("Longitude")),
    placeId: str(p("PlaceId")),
    source: str(p("LocationSource")),
    accuracyMeters: num(p("AccuracyMeters")),
    confirmedAt: dt(p("ConfirmedAt")),
  };
}

/** 확정본 행과 폴백 행을 같은 모양으로 맞춘다. 두 경로가 어긋나면 그 자체가 사고다. */
function toEntry(r: RawRow, origin: ShuttleRosterSource): ShuttleRosterEntry {
  return {
    origin,
    rosterId: origin === "CONFIRMED" ? String(r.rosterId) : null,
    seasonId: String(r.seasonId),
    shuttleRequestId: String(r.shuttleRequestId),
    applicationId: str(r.applicationId),
    applicationItemId: str(r.applicationItemId),
    studentId: str(r.studentId),
    ride: r.ride === true,
    studentName: String(r.studentName ?? ""),
    childGrade: str(r.childGrade),
    childGender: str(r.childGender),
    childPhone: str(r.childPhone),
    parentName: str(r.parentName),
    parentPhone: str(r.parentPhone),
    offeringId: str(r.offeringId),
    offeringTitle: str(r.offeringTitle),
    weekdays: weekdayList(r.weekdays),
    classStart: str(r.classStart),
    classEnd: str(r.classEnd),
    pickup: place(r, "pickup"),
    pickupTime: str(r.pickupTime),
    dropoff: place(r, "dropoff"),
    dropoffSameAsPickup: r.dropoffSameAsPickup === true,
    note: str(r.note),
    requestCreatedAt: dt(r.requestCreatedAt),
  };
}

// 폴백 SELECT 목록. 확정본 컬럼명과 1:1로 맞춰 두 경로의 결과 모양을 강제로 같게 만든다.
const FALLBACK_COLUMNS = `
        a."seasonId"                AS "seasonId",
        r.id                        AS "shuttleRequestId",
        r."applicationId"           AS "applicationId",
        r."applicationItemId"       AS "applicationItemId",
        -- 학생 전환이 끝난 경우에만 자녀와 이어 붙인다(학부모 화면의 기존 조건과 동일).
        CASE WHEN it."conversionStatus" = 'COMPLETED' THEN a."convertedStudentId" ELSE NULL END AS "studentId",
        a."childName"               AS "studentName",
        a."childGrade"              AS "childGrade",
        a."childGender"             AS "childGender",
        a."childPhone"              AS "childPhone",
        a."parentName"              AS "parentName",
        a."parentPhone"             AS "parentPhone",
        it."offeringId"             AS "offeringId",
        COALESCE(it."titleSnapshot", o.title) AS "offeringTitle",
        a."selectedWeekdays"        AS "weekdays",
        (SELECT to_char(min(sd."startsAt") AT TIME ZONE 'Asia/Seoul','HH24:MI')
           FROM "SpecialProgramSessionDate" sd WHERE sd."offeringId" = o.id) AS "classStart",
        (SELECT to_char(min(sd."endsAt")   AT TIME ZONE 'Asia/Seoul','HH24:MI')
           FROM "SpecialProgramSessionDate" sd WHERE sd."offeringId" = o.id) AS "classEnd",
        r."pickupLocation", r."pickupAddress", r."pickupRoadAddress",
        r."pickupLatitude", r."pickupLongitude", r."pickupPlaceId",
        r."pickupLocationSource", r."pickupAccuracyMeters", r."pickupConfirmedAt", r."pickupTime",
        r."dropoffLocation", r."dropoffAddress", r."dropoffRoadAddress",
        r."dropoffLatitude", r."dropoffLongitude", r."dropoffPlaceId",
        r."dropoffLocationSource", r."dropoffAccuracyMeters", r."dropoffConfirmedAt",
        COALESCE(r."dropoffSameAsPickup", false) AS "dropoffSameAsPickup",
        r.note                      AS "note",
        r."createdAt"               AS "requestCreatedAt",
        r.status                    AS "requestStatus"`;

// 확정본 SELECT 목록. 컬럼 별칭을 폴백과 똑같이 맞춘다.
const CONFIRMED_COLUMNS = `
        sr.id                       AS "rosterId",
        sr."seasonId"               AS "seasonId",
        sr."shuttleRequestId"       AS "shuttleRequestId",
        req."applicationId"         AS "applicationId",
        sr."applicationItemId"      AS "applicationItemId",
        sr."studentIdSnapshot"      AS "studentId",
        sr.ride                     AS "ride",
        sr."studentNameSnapshot"    AS "studentName",
        sr."childGradeSnapshot"     AS "childGrade",
        sr."childGenderSnapshot"    AS "childGender",
        sr."childPhoneSnapshot"     AS "childPhone",
        sr."parentNameSnapshot"     AS "parentName",
        sr."parentPhoneSnapshot"    AS "parentPhone",
        sr."offeringIdSnapshot"     AS "offeringId",
        sr."offeringTitleSnapshot"  AS "offeringTitle",
        sr."weekdaysSnapshot"       AS "weekdays",
        sr."classStartSnapshot"     AS "classStart",
        sr."classEndSnapshot"       AS "classEnd",
        sr."pickupLocation", sr."pickupAddress", sr."pickupRoadAddress",
        sr."pickupLatitude", sr."pickupLongitude", sr."pickupPlaceId",
        sr."pickupLocationSource", sr."pickupAccuracyMeters", sr."pickupConfirmedAt", sr."pickupTime",
        sr."dropoffLocation", sr."dropoffAddress", sr."dropoffRoadAddress",
        sr."dropoffLatitude", sr."dropoffLongitude", sr."dropoffPlaceId",
        sr."dropoffLocationSource", sr."dropoffAccuracyMeters", sr."dropoffConfirmedAt",
        sr."dropoffSameAsPickup",
        sr.note                     AS "note",
        sr."requestCreatedAtSnapshot" AS "requestCreatedAt"`;

/**
 * 확정 시점 원본 값의 지문(md5). 4단계 "변동 감지"가 이 값을 다시 계산해 비교한다.
 * 기사님이 물리적으로 찾아가는 값(주소·좌표)과 사람 정보, 그리고 상태값을 모두 포함한다.
 * ⚠️ 여기 목록을 바꾸면 기존 확정본의 지문과 어긋나 전원이 '변동됨'으로 뜬다. 함부로 고치지 말 것.
 */
const SOURCE_FINGERPRINT_SQL = `md5(concat_ws('|',
              a."childName", a."childGrade", a."childGender", a."childPhone", a."parentName", a."parentPhone",
              it."offeringId", COALESCE(it."titleSnapshot", o.title), array_to_string(a."selectedWeekdays", ','),
              r."pickupLocation", r."pickupAddress", r."pickupRoadAddress",
              r."pickupLatitude"::text, r."pickupLongitude"::text, r."pickupTime",
              r."dropoffLocation", r."dropoffAddress", r."dropoffRoadAddress",
              r."dropoffLatitude"::text, r."dropoffLongitude"::text,
              COALESCE(r."dropoffSameAsPickup", false)::text,
              r.status, a.status, it.status, o.status))`;

// 명단 기본 정렬: 탑승자 먼저 → 수업 시작 시각 → 이름.
// 기존 통합 명단 화면의 ORDER BY와 글자 하나까지 같은 기준이다(순서가 바뀌면 그것도 회귀다).
const ROSTER_ORDER = `ORDER BY "ride" DESC, "classStart" NULLS LAST, "studentName" ASC`;

// ────────────────────────────────────────────────────────────────
// 노출 함수 1 — 시즌 확정 명단
// ────────────────────────────────────────────────────────────────

/**
 * 시즌 셔틀 확정 명단. 미탑승(ride=false) 행도 함께 돌려준다.
 * 미탑승 행을 지우면 "역시 태워주세요" 연락이 왔을 때 되돌릴 방법이 사라지기 때문이다.
 * 탑승자만 필요한 화면은 `rows.filter((row) => row.ride)`로 거른다.
 */
export async function getConfirmedShuttleRoster(seasonId?: string | null): Promise<ShuttleRosterEntry[]> {
  // ★ 판정 기준은 "보이는 행이 있느냐"가 아니라 "확정본이 존재하느냐"다.
  //   보이는 행으로 판정하면, 원장이 명단에서 전원을 빼는 순간 확정본이 비어 보여 폴백이 되살아나고
  //   **일부러 뺀 학생이 기사님 CSV에 다시 나타난다.** 게다가 확정 버튼을 다시 눌러도
  //   ON CONFLICT DO NOTHING이라 아무 일도 안 일어나 빠져나갈 방법이 없다.
  // ★ 판정은 «시즌마다» 한다(R-7②, 2026-11-10). 예전엔 보관 안 된 시즌 중 하나라도 확정본이 있으면
  //   전체를 확정본으로만 읽어, 다음 시즌(확정 전) 신청자가 기사님 명단·학부모 화면·안내에서 통째로 빠졌다.
  //   확정한 시즌 = 확정본만, 확정 전 시즌 = 원본 폴백. 한 시즌 안에서는 여전히 둘을 섞지 않는다.
  if (!(await confirmedModeEnabled())) return fallbackSeasonRoster(seasonId);
  const confirmedSeasons = await confirmedSeasonIds(seasonId);
  if (confirmedSeasons.length === 0) return fallbackSeasonRoster(seasonId);
  const confirmedRows = await confirmedSeasonRoster(confirmedSeasons);
  // 시즌을 지정했으면 그 시즌은 확정본이 정본이다(결과가 빈 목록이어도 그대로 — "아무도 안 태운다"가 원장의 결정).
  if (seasonId) return confirmedRows;
  const pendingRows = await fallbackSeasonRoster(null, confirmedSeasons);
  if (pendingRows.length === 0) return confirmedRows;
  return sortRosterEntries([...confirmedRows, ...pendingRows]);
}

/** 확정본 행 — 지정한 시즌들만(그 시즌들에 확정본이 있다는 것은 호출한 쪽이 이미 확인했다). */
async function confirmedSeasonRoster(seasonIds: string[]): Promise<ShuttleRosterEntry[]> {
  const rows = await prisma.$queryRawUnsafe<RawRow[]>(
    `SELECT ${CONFIRMED_COLUMNS}
       FROM "SeasonalShuttleRoster" sr
       JOIN "SpecialProgramSeason" s ON s.id = sr."seasonId"
       LEFT JOIN "SpecialProgramShuttleRequest" req ON req.id = sr."shuttleRequestId"
       LEFT JOIN "SpecialProgramApplicationItem" ai ON ai.id = sr."applicationItemId"
      WHERE sr."removedAt" IS NULL
        AND (ai.id IS NULL OR ai.status NOT IN ('CANCELLED', 'REJECTED'))
        AND sr."seasonId" = ANY($1::text[])
      ${ROSTER_ORDER}`,
    seasonIds,
  );
  return rows.map((r) => toEntry(r, "CONFIRMED"));
}

/** 두 시즌 결과를 합칠 때만 쓰는 정렬 — SQL 의 ROSTER_ORDER(탑승 먼저·수업 시작·이름)와 같은 순서. */
function sortRosterEntries(entries: ShuttleRosterEntry[]): ShuttleRosterEntry[] {
  return entries.sort((a, b) => {
    if (a.ride !== b.ride) return a.ride ? -1 : 1;
    if (a.classStart !== b.classStart) {
      if (a.classStart == null) return 1;
      if (b.classStart == null) return -1;
      return a.classStart < b.classStart ? -1 : 1;
    }
    return a.studentName.localeCompare(b.studentName, "ko");
  });
}

/**
 * 범위 안에서 확정본이 있는 시즌 id 목록(제외된 행 포함 — 전원 제외가 폴백 부활로 이어지면 안 된다).
 * 테이블이 없는 구버전 DB 면 빈 목록(= 폴백).
 */
async function confirmedSeasonIds(seasonId?: string | null): Promise<string[]> {
  const scope = seasonScope({ roster: "sr", season: "s" }, seasonId);
  try {
    const rows = await prisma.$queryRawUnsafe<RawRow[]>(
      `SELECT DISTINCT sr."seasonId" AS "seasonId"
         FROM "SeasonalShuttleRoster" sr
         JOIN "SpecialProgramSeason" s ON s.id = sr."seasonId"
        WHERE ${scope.where}`,
      ...scope.params,
    );
    return rows.map((r) => String(r.seasonId));
  } catch {
    return [];
  }
}

/**
 * 이 시즌에 확정본 행이 하나라도 있는가(제외된 행 포함).
 * 제외된 행까지 세는 이유는 위 주석 그대로다 — 전원 제외가 폴백 부활로 이어지면 안 된다.
 */
async function confirmedRosterExists(seasonId?: string | null): Promise<boolean> {
  const scope = seasonScope({ roster: "sr", season: "s" }, seasonId);
  try {
    const rows = await prisma.$queryRawUnsafe<RawRow[]>(
      `SELECT 1 AS one
         FROM "SeasonalShuttleRoster" sr
         JOIN "SpecialProgramSeason" s ON s.id = sr."seasonId"
        WHERE ${scope.where}
        LIMIT 1`,
      ...scope.params,
    );
    return rows.length > 0;
  } catch {
    // 테이블이 없는 구버전 DB에서는 폴백으로 동작한다(화면이 비는 것보다 안전하다).
    return false;
  }
}

/**
 * 폴백 — 아직 아무도 확정 버튼을 누르지 않았을 때 원본에서 그대로 뽑는다.
 * 전환 이전 화면과 **완전히 같은 결과**를 내는 것이 이 함수의 유일한 목표다.
 * 셔틀 상태(r.status)는 SQL에서 거르지 않고 ride 값으로만 표시한다.
 */
async function fallbackSeasonRoster(seasonId?: string | null, excludeSeasonIds: string[] = []): Promise<ShuttleRosterEntry[]> {
  const scope = seasonScope({ application: "a", season: "s" }, seasonId);
  // 확정본이 있는 시즌은 빼고 읽는다(그 시즌은 확정본이 정본 — 한 시즌 안에서 원본을 섞지 않는다).
  const exclude = excludeSeasonIds.length > 0 ? ` AND NOT (a."seasonId" = ANY($${scope.params.length + 1}::text[]))` : "";
  const rows = await prisma.$queryRawUnsafe<RawRow[]>(
    `SELECT * FROM (
       SELECT ${FALLBACK_COLUMNS},
              ${ridingShuttleStatusSql("r")} AS "ride"
         FROM "SpecialProgramShuttleRequest" r
         JOIN "SpecialProgramApplication" a ON a.id = r."applicationId"
         JOIN "SpecialProgramSeason" s ON s.id = a."seasonId"
         LEFT JOIN "SpecialProgramApplicationItem" it ON it.id = r."applicationItemId"
         LEFT JOIN "SpecialProgramOffering" o ON o.id = it."offeringId"
        WHERE ${scope.where}${exclude}
          AND ${seasonalShuttleEligibilitySql({ application: "a", item: "it", offering: "o" })}
     ) t
     ${ROSTER_ORDER}`,
    ...scope.params,
    ...(excludeSeasonIds.length > 0 ? [excludeSeasonIds] : []),
  );
  return rows.map((r) => toEntry({ ...r, ride: isRidingShuttleStatus(r.requestStatus) }, "FALLBACK"));
}

// ────────────────────────────────────────────────────────────────
// 노출 함수 2 — 날짜별 운행 명단 (확정본 × 그 날짜 좌석)
// ────────────────────────────────────────────────────────────────

/** 방향에 맞는 위치 한 벌을 고른다. '하원=등원 동일'이면 등원 값을 그대로 쓴다. */
function placeForDirection(entry: ShuttleRosterEntry, direction: "PICKUP" | "DROPOFF") {
  if (direction === "PICKUP") return entry.pickup;
  if (entry.dropoffSameAsPickup) return entry.pickup;
  // 하원 좌표가 비어 있으면 등원 좌표로 폴백한다(기존 자동 배차와 같은 규칙).
  return entry.dropoff.latitude != null && entry.dropoff.longitude != null ? entry.dropoff : {
    ...entry.dropoff,
    location: entry.dropoff.location ?? entry.pickup.location,
    latitude: entry.pickup.latitude,
    longitude: entry.pickup.longitude,
    source: entry.pickup.source,
    confirmedAt: entry.pickup.confirmedAt,
  };
}

/**
 * 그 날짜에 실제로 태울 사람.
 *
 * 날짜별 명단을 따로 저장하지 않는 이유(원장 승인): 15운행일 × 2방향 = 30번 확정은 운영이 불가능하다.
 * 대신 **시즌 확정본 × 그날 좌석(SpecialProgramEnrollmentDate.status='SCHEDULED')**으로 파생한다.
 * 그날 수업이 취소되면 좌석이 SCHEDULED가 아니게 되므로 **그날 노선에서만 자동으로 빠지고**,
 * 시즌 명단에는 그대로 남는다. 이게 이 구조를 고른 핵심 이유다.
 *
 * `date`가 null이면 운행일 후보만 채워 돌려준다(첫 진입 시 드롭다운 채우기용).
 */
export async function getConfirmedShuttleRosterForDate(
  date: string | null,
  direction: "PICKUP" | "DROPOFF",
  opts?: { includeAbsent?: boolean },
): Promise<ShuttleRosterDatePlan> {
  const includeAbsent = opts?.includeAbsent ?? false;
  // 시즌 명단을 먼저 얻는다(확정본이든 폴백이든 여기서 이미 판정이 끝난다).
  const roster = await getConfirmedShuttleRoster();
  const riding = roster.filter((row) => row.ride);
  const byItemId = new Map<string, ShuttleRosterEntry>();
  for (const row of riding) if (row.applicationItemId) byItemId.set(row.applicationItemId, row);

  const origin: ShuttleRosterSource = roster[0]?.origin ?? "FALLBACK";
  const base: ShuttleRosterDatePlan = {
    origin, date: null, direction, availableDates: [], riders: [], classStart: null, classEnd: null,
  };
  if (byItemId.size === 0) return base;

  // 좌석(날짜 계층)은 스냅샷 대상이 아니다. 명단에 든 수강항목의 좌석만 날짜별로 읽는다.
  const itemIds = [...byItemId.keys()];
  const seats = await prisma.$queryRawUnsafe<RawRow[]>(
    `SELECT e."applicationItemId" AS "itemId",
            (sd."startsAt" AT TIME ZONE 'Asia/Seoul')::date::text AS "serviceDate",
            EXTRACT(DOW FROM (sd."startsAt" AT TIME ZONE 'Asia/Seoul'))::int AS "dow",
            to_char(sd."startsAt" AT TIME ZONE 'Asia/Seoul','HH24:MI') AS "sessionStart",
            to_char(sd."endsAt"   AT TIME ZONE 'Asia/Seoul','HH24:MI') AS "sessionEnd",
            e."attendanceStatus" AS "attendanceStatus"
       FROM "SpecialProgramEnrollmentDate" e
       JOIN "SpecialProgramSessionDate" sd ON sd.id = e."sessionDateId"
      WHERE e.status = 'SCHEDULED'
        -- includeAbsent=false(기본): 결석·사유결석은 그날 노선에서 제외.
        -- includeAbsent=true: 전체 포함(저장 노선 reconcile용). 결석 여부는 attendanceStatus로 구분.
        ${includeAbsent ? "" : `AND (e."attendanceStatus" IS NULL OR e."attendanceStatus" NOT IN ('ABSENT', 'EXCUSED'))`}
        AND e."applicationItemId" = ANY($1::text[])
      ORDER BY "serviceDate" ASC, "sessionStart" ASC`,
    itemIds,
  );

  const dateMap = new Map<string, number>();
  for (const seat of seats) dateMap.set(String(seat.serviceDate), Number(seat.dow));
  const availableDates = [...dateMap.entries()]
    .map(([d, dow]) => ({ date: d, dow }))
    .sort((left, right) => left.date.localeCompare(right.date));

  const selected = date && dateMap.has(date) ? date : (availableDates[0]?.date ?? null);
  if (!selected) return { ...base, availableDates };

  const riders: ShuttleRosterRider[] = [];
  const seen = new Set<string>();
  for (const seat of seats) {
    if (String(seat.serviceDate) !== selected) continue;
    const entry = byItemId.get(String(seat.itemId));
    if (!entry) continue;
    // 같은 날 같은 신청이 두 번 잡히면(세션 중복) 한 명으로 센다. 기존 쿼리의 DISTINCT와 같은 역할.
    if (seen.has(entry.shuttleRequestId)) continue;
    seen.add(entry.shuttleRequestId);
    const chosen = placeForDirection(entry, direction);
    const attendanceStatus = str(seat.attendanceStatus);
    const isAbsent = includeAbsent && (attendanceStatus === "ABSENT" || attendanceStatus === "EXCUSED");
    riders.push({
      ...entry,
      serviceDate: selected,
      sessionStart: str(seat.sessionStart),
      sessionEnd: str(seat.sessionEnd),
      place: chosen,
      placeLabel: chosen.location ?? entry.pickup.location ?? "(위치 미지정)",
      ...(isAbsent ? { isAbsent: true } : {}),
    });
  }

  // 기존 배차 쿼리와 같은 정렬: 수업 시작 시각 → 이름.
  riders.sort((left, right) =>
    (left.sessionStart ?? "").localeCompare(right.sessionStart ?? "") ||
    left.studentName.localeCompare(right.studentName, "ko"),
  );

  // 그 날의 기준 시각. "첫 학생 것"을 쓰면 같은 날 시간대가 다른 반이 생기는 순간 무너진다.
  // 등원은 **가장 먼저 시작하는 반**(늦으면 지각), 하원은 **가장 늦게 끝나는 반**(일찍 가면 못 태움) 기준이어야 한다.
  // 현재 데이터는 전 일자 09:30~10:50 단일 시간대라 결과는 첫 학생 기준과 완전히 같다(실측 확인).
  const classStart = riders.reduce<string | null>(
    (acc, r) => (r.sessionStart && (acc === null || r.sessionStart < acc) ? r.sessionStart : acc), null);
  const classEnd = riders.reduce<string | null>(
    (acc, r) => (r.sessionEnd && (acc === null || r.sessionEnd > acc) ? r.sessionEnd : acc), null);

  return { origin, date: selected, direction, availableDates, riders, classStart, classEnd };
}

/**
 * **그 요일 노선에 속한 사람**의 shuttleRequestId 집합.
 *
 * 왜 "하루"가 아니라 "요일"인가(2026-08-03 실제 사고):
 *   노선은 요일 단위로 저장되고 그 요일의 대표일(첫 운행일) 한 건만 조회한다.
 *   그런데 노선 소속 판정까지 대표일 하루로 하면, **시즌 중간에 합류한 학생은
 *   그 요일 노선에 영원히 들어갈 수 없다** — 대표일에 좌석이 없어 '소속 아님'으로
 *   걸러지고, 노선에 넣어도 읽을 때마다 reconcile이 다시 지운다.
 *   실제로 8/10부터 등원하는 학생(월·수)이 7/27·8/05 좌석이 CANCELLED라
 *   월·수 노선에 배정 자체가 불가능했다.
 *
 * 그래서 "그 요일에 SCHEDULED 좌석이 **하나라도** 있으면 그 요일 노선 소속"으로 본다.
 * 중도 합류·중도 종료가 모두 자연스럽게 처리된다.
 *
 * ⚠️ 출결(그날 결석인가)은 이 함수가 판정하지 않는다. 소속과 출결은 별개다 —
 *    소속이지만 그날 좌석이 없는 사람(아직 시작 전·이미 종료)은 호출부에서 결석으로 표시한다.
 */
export async function getWeekdayMembers(
  date: string,
  direction: "PICKUP" | "DROPOFF",
): Promise<ShuttleRosterRider[]> {
  const roster = await getConfirmedShuttleRoster();
  const byItemId = new Map<string, ShuttleRosterEntry>();
  for (const row of roster) if (row.ride && row.applicationItemId) byItemId.set(row.applicationItemId, row);
  if (byItemId.size === 0) return [];

  const rows = await prisma.$queryRawUnsafe<RawRow[]>(
    `SELECT DISTINCT e."applicationItemId" AS "itemId"
       FROM "SpecialProgramEnrollmentDate" e
       JOIN "SpecialProgramSessionDate" sd ON sd.id = e."sessionDateId"
      WHERE e.status = 'SCHEDULED'
        AND EXTRACT(DOW FROM (sd."startsAt" AT TIME ZONE 'Asia/Seoul'))
          = EXTRACT(DOW FROM $1::date)
        AND e."applicationItemId" = ANY($2::text[])`,
    date, [...byItemId.keys()],
  );

  // 소속자는 "그 요일에 타는 사람"이지 "특정 날짜에 타는 사람"이 아니다.
  // 그래서 세션 시각(sessionStart/End)은 채우지 않는다 — 날짜마다 다르고, 여기서는 의미가 없다.
  const members: ShuttleRosterRider[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const entry = byItemId.get(String(row.itemId));
    if (!entry || seen.has(entry.shuttleRequestId)) continue;
    seen.add(entry.shuttleRequestId);
    const chosen = placeForDirection(entry, direction);
    members.push({
      ...entry,
      serviceDate: date,
      sessionStart: null,
      sessionEnd: null,
      place: chosen,
      placeLabel: chosen.location ?? entry.pickup.location ?? "(위치 미지정)",
    });
  }
  return members;
}

// ────────────────────────────────────────────────────────────────
// 확정 · 수정 · 제외 (원장 전용)
// ────────────────────────────────────────────────────────────────

/**
 * 확정·수정은 원장(ADMIN)만 할 수 있다. 부원장(VICE_ADMIN)도 막는다.
 * "확정 = 사람이 눈으로 확인했다"는 뜻이라 책임자가 명확해야 하기 때문이다.
 * requireOwner()를 쓰지 않는 이유: 확정자(confirmedByUserId)로 남길 앱 계정 id가 필요하다.
 */
async function requireRosterOwner() {
  const admin = await requireAdmin();
  if (admin.appUserRole !== "ADMIN") {
    throw new Error("셔틀 명단 확정은 원장(ADMIN)만 할 수 있습니다.");
  }
  return admin;
}

/**
 * 시즌 셔틀 명단을 확정한다(원본 → 확정본 복제).
 *
 * ⚠️ 자동으로 부르지 마라. 원장이 화면에서 버튼을 눌렀을 때만 실행한다.
 *    자동 백필하면 "사람이 확인했다"는 확정의 의미가 사라진다.
 * 이미 확정된 행은 건드리지 않는다(ON CONFLICT DO NOTHING) — 원장이 손으로 고쳐 둔 값이
 * 재확정 한 번에 원본으로 되돌아가면 안 되기 때문이다. 변동 반영은 4단계에서 별도로 만든다.
 */
export async function confirmSeasonalShuttleRoster(seasonId?: string | null): Promise<{ inserted: number }> {
  const admin = await requireRosterOwner();
  const scope = seasonScope({ application: "a", season: "s" }, seasonId);
  const userParam = `$${scope.params.length + 1}`;

  const inserted = await prisma.$executeRawUnsafe(
    `INSERT INTO "SeasonalShuttleRoster" (
        "seasonId", "shuttleRequestId", "applicationItemId",
        "studentIdSnapshot", "studentNameSnapshot", "childGradeSnapshot", "childGenderSnapshot",
        "childPhoneSnapshot", "parentNameSnapshot", "parentPhoneSnapshot",
        "offeringIdSnapshot", "offeringTitleSnapshot", "weekdaysSnapshot",
        "classStartSnapshot", "classEndSnapshot", "requestCreatedAtSnapshot", "ride",
        "pickupLocation", "pickupAddress", "pickupRoadAddress", "pickupLatitude", "pickupLongitude",
        "pickupPlaceId", "pickupLocationSource", "pickupAccuracyMeters", "pickupConfirmedAt", "pickupTime",
        "dropoffLocation", "dropoffAddress", "dropoffRoadAddress", "dropoffLatitude", "dropoffLongitude",
        "dropoffPlaceId", "dropoffLocationSource", "dropoffAccuracyMeters", "dropoffConfirmedAt",
        "dropoffSameAsPickup",
        "sourceFingerprint", "confirmedByUserId"
     )
     SELECT a."seasonId", r.id, r."applicationItemId",
            CASE WHEN it."conversionStatus" = 'COMPLETED' THEN a."convertedStudentId" ELSE NULL END,
            a."childName", a."childGrade", a."childGender",
            a."childPhone", a."parentName", a."parentPhone",
            it."offeringId", COALESCE(it."titleSnapshot", o.title), to_jsonb(a."selectedWeekdays"),
            (SELECT to_char(min(sd."startsAt") AT TIME ZONE 'Asia/Seoul','HH24:MI')
               FROM "SpecialProgramSessionDate" sd WHERE sd."offeringId" = o.id),
            (SELECT to_char(min(sd."endsAt") AT TIME ZONE 'Asia/Seoul','HH24:MI')
               FROM "SpecialProgramSessionDate" sd WHERE sd."offeringId" = o.id),
            r."createdAt",
            ${ridingShuttleStatusSql("r")},
            r."pickupLocation", r."pickupAddress", r."pickupRoadAddress", r."pickupLatitude", r."pickupLongitude",
            r."pickupPlaceId", r."pickupLocationSource", r."pickupAccuracyMeters", r."pickupConfirmedAt", r."pickupTime",
            r."dropoffLocation", r."dropoffAddress", r."dropoffRoadAddress", r."dropoffLatitude", r."dropoffLongitude",
            r."dropoffPlaceId", r."dropoffLocationSource", r."dropoffAccuracyMeters", r."dropoffConfirmedAt",
            COALESCE(r."dropoffSameAsPickup", false),
            ${SOURCE_FINGERPRINT_SQL},
            ${userParam}
       FROM "SpecialProgramShuttleRequest" r
       JOIN "SpecialProgramApplication" a ON a.id = r."applicationId"
       JOIN "SpecialProgramSeason" s ON s.id = a."seasonId"
       JOIN "SpecialProgramApplicationItem" it ON it.id = r."applicationItemId"
       JOIN "SpecialProgramOffering" o ON o.id = it."offeringId"
      WHERE ${scope.where}
        -- 이미 확정한 시즌은 다시 채우지 않는다(R-7②): 확정 후 새 신청이 그 시즌 명단에 슬며시 들어가면
        -- «확정하면 새 신청이 자동으로 추가되지 않는다»는 약속이 깨진다. 확정 전 시즌(다음 방학)만 확정한다.
        AND NOT EXISTS (SELECT 1 FROM "SeasonalShuttleRoster" done WHERE done."seasonId" = a."seasonId")
        AND ${seasonalShuttleEligibilitySql({ application: "a", item: "it", offering: "o" })}
     ON CONFLICT ("seasonId", "shuttleRequestId") DO NOTHING`,
    ...scope.params,
    admin.appUserId,
  );

  // 확정본이 실제로 생겼을 때만 킬 스위치를 켠다.
  // 이건 자동 백필이 아니다 — 원장이 확정 버튼을 누른 그 순간에만 실행된다.
  if (inserted > 0) {
    await prisma.$executeRawUnsafe(
      `UPDATE "AcademySettings" SET "shuttleRosterConfirmedMode" = true, "updatedAt" = now() WHERE id = 'singleton'`,
    );
  }
  return { inserted };
}

/**
 * 확정본 한 행 수정. 원본(SpecialProgramShuttleRequest)은 건드리지 않는다.
 * 지도 핀도 여기서만 처리한다 — 확정 후 원본에 쓰면 확정본과 원본이 갈라져 어느 쪽이 정본인지 알 수 없게 된다.
 *
 * ★ SET 절 조립 규칙(같은 컬럼 중복 금지·파라미터 번호·핀과 텍스트 우선순위)은 의존성 없는 순수 모듈
 *   `shuttleRosterEdit.ts`에 있다. 그 규칙의 결함(예: 컬럼 중복 → Postgres 42701 → 500)은 소스 문자열
 *   검사로는 절대 못 잡아서, 실제로 돌려 보는 테스트가 가능하도록 떼어 놓았다.
 */
export async function updateConfirmedShuttleRosterRow(rosterId: string, patch: ConfirmedRosterPatch) {
  await requireRosterOwner();
  if (!rosterId) throw new Error("rosterId required");

  // 좌표 검증도 여기서 끝난다(좌표가 이상하면 던지고, 아래 UPDATE는 아예 실행되지 않는다).
  const { sets, args } = buildConfirmedRosterUpdate(rosterId, patch);
  let changed = 0;
  if (sets.length > 0) {
    changed = await prisma.$executeRawUnsafe(
      `UPDATE "SeasonalShuttleRoster" SET ${sets.join(", ")}, "updatedAt" = now() WHERE id = $1`,
      ...args,
    );
  }

  // '하원=등원 동일'이 켜져 있으면 등원 좌표·주소를 하원으로 복제한다(폴백 경로와 같은 규칙).
  const cur = await prisma.$queryRawUnsafe<RawRow[]>(
    `SELECT "dropoffSameAsPickup" AS same, "pickupLatitude" AS lat FROM "SeasonalShuttleRoster" WHERE id = $1`,
    rosterId,
  );
  if (cur[0]?.same === true) {
    await prisma.$executeRawUnsafe(
      `UPDATE "SeasonalShuttleRoster"
          SET "dropoffLocation" = "pickupLocation",
              "dropoffAddress" = "pickupAddress",
              "dropoffRoadAddress" = "pickupRoadAddress",
              "dropoffLatitude" = "pickupLatitude",
              "dropoffLongitude" = "pickupLongitude",
              "dropoffPlaceId" = "pickupPlaceId",
              "dropoffLocationSource" = CASE WHEN "pickupLatitude" IS NOT NULL THEN COALESCE("pickupLocationSource", 'SEARCH') ELSE "dropoffLocationSource" END,
              "dropoffAccuracyMeters" = "pickupAccuracyMeters",
              "dropoffConfirmedAt" = CASE WHEN "pickupLatitude" IS NOT NULL THEN COALESCE("pickupConfirmedAt", now()) ELSE "dropoffConfirmedAt" END,
              "updatedAt" = now()
        WHERE id = $1`,
      rosterId,
    );
  }

  return { ok: true, changed };
}

/**
 * 확정 명단에서 제외(soft remove). 하드 DELETE는 절대 하지 않는다 —
 * "왜 이 학생이 명단에서 사라졌나"를 나중에 되짚을 수 없게 되기 때문이다.
 */
export async function removeConfirmedShuttleRosterRow(rosterId: string, reason?: string | null) {
  await requireRosterOwner();
  if (!rosterId) throw new Error("rosterId required");
  const changed = await prisma.$executeRawUnsafe(
    `UPDATE "SeasonalShuttleRoster"
        SET "removedAt" = now(), "removedReason" = $2, "updatedAt" = now()
      WHERE id = $1 AND "removedAt" IS NULL`,
    rosterId,
    str(reason),
  );
  return { ok: true, changed };
}

/**
 * 확정본을 shuttleRequestId(원본 신청서 id)로 빼거나 되돌린다.
 *
 * 왜 필요한가: 신청관리 드로어는 확정본 rosterId를 모른 채 원본 신청서(shuttleRequest)만 들고 있다.
 * 확정된 학생을 그 화면에서 "셔틀 신청 취소"하려면 requestId → 확정본 행을 서버가 직접 찾아 처리해야 한다.
 *
 * @param ride false = 명단에서 제외(soft remove), true = 복구.
 * @returns changed = 실제로 바뀐 행 수(0이면 확정본에 해당 학생이 없었다는 뜻).
 */
export async function setConfirmedShuttleRideByRequestId(shuttleRequestId: string, ride: boolean) {
  await requireRosterOwner();
  if (!shuttleRequestId) throw new Error("shuttleRequestId required");
  const changed = ride
    ? await prisma.$executeRawUnsafe(
        `UPDATE "SeasonalShuttleRoster"
            SET "removedAt" = NULL, "removedReason" = NULL, "updatedAt" = now()
          WHERE "shuttleRequestId" = $1 AND "removedAt" IS NOT NULL`,
        shuttleRequestId,
      )
    : await prisma.$executeRawUnsafe(
        `UPDATE "SeasonalShuttleRoster"
            SET "removedAt" = now(), "removedReason" = '신청관리에서 취소', "updatedAt" = now()
          WHERE "shuttleRequestId" = $1 AND "removedAt" IS NULL`,
        shuttleRequestId,
      );
  // 원본 신청서 status도 함께 맞춰 화면(신청관리 드로어)이 취소 상태를 일관되게 보이도록 한다.
  //   드라이버 명단은 확정본 removedAt이 진실이므로, status 변경은 UI 신호용이다.
  await prisma.$executeRawUnsafe(
    `UPDATE "SpecialProgramShuttleRequest" SET "status" = $2, "updatedAt" = now() WHERE id = $1`,
    shuttleRequestId,
    ride ? "REQUESTED" : "CANCELLED",
  );
  return { ok: true, changed };
}

/**
 * 학생을 무료 탑승 거점(1호점)으로 직접 배치한다(관리자용).
 *
 * 하는 일:
 *   1) 탑승 위치 = 거점(1호점) 좌표·라벨('무료탑승' 포함 → 배차/셔틀비 로직이 거점으로 인식).
 *   2) 하차 위치 = 하차 거점(길 건너, 미설정 시 탑승 거점과 동일).
 *   3) 셔틀 이용 상태(REQUESTED)로 켜고, 확정본에서 빠져 있었으면 되돌린다.
 *   4) 아직 청구 전(paymentId 없음)이면 그 신청 항목의 셔틀비를 0원으로 내리고 합계를 다시 계산한다.
 *
 * hub 설정은 순환 import를 피하려 AcademySettings에서 직접 읽는다.
 */
export async function placeStudentAtFreeHub(target: { rosterId?: string | null; requestId?: string | null }) {
  await requireRosterOwner();
  let requestId = target.requestId ?? null;
  if (!requestId && target.rosterId) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT "shuttleRequestId" AS rid FROM "SeasonalShuttleRoster" WHERE id = $1`, target.rosterId,
    );
    requestId = rows[0]?.rid ? String(rows[0].rid) : null;
  }
  if (!requestId) throw new Error("셔틀 신청을 찾을 수 없습니다.");

  const s = (await prisma.$queryRawUnsafe<any[]>(
    `SELECT "shuttleHubName" AS pname, "shuttleHubLatitude" AS plat, "shuttleHubLongitude" AS plng,
            "shuttleHubDropoffName" AS dname, "shuttleHubDropoffLatitude" AS dlat, "shuttleHubDropoffLongitude" AS dlng
       FROM "AcademySettings" LIMIT 1`,
  ))[0] ?? {};
  const plat = Number(s.plat), plng = Number(s.plng);
  if (!Number.isFinite(plat) || !Number.isFinite(plng)) {
    throw new Error("무료 탑승 거점이 설정되지 않았습니다. 차량 관리에서 먼저 지정하세요.");
  }
  const pname = (s.pname && String(s.pname)) || "무료 탑승 거점";
  const label = `${pname}(무료탑승)`;
  const dlat = Number(s.dlat), dlng = Number(s.dlng);
  const hasDrop = Number.isFinite(dlat) && Number.isFinite(dlng);
  const dLat = hasDrop ? dlat : plat, dLng = hasDrop ? dlng : plng;
  const dName = (hasDrop && s.dname && String(s.dname)) || pname;

  // 1~2) 원본 신청서의 탑승/하차를 거점으로 덮어쓴다.
  await prisma.$executeRawUnsafe(
    `UPDATE "SpecialProgramShuttleRequest" SET
        "status" = 'REQUESTED', "dropoffSameAsPickup" = false,
        "pickupLocation" = $2, "pickupLatitude" = $3, "pickupLongitude" = $4,
        "pickupAddress" = $5, "pickupRoadAddress" = $5, "pickupLocationSource" = 'MAP_PIN', "pickupConfirmedAt" = now(),
        "dropoffLocation" = $6, "dropoffLatitude" = $7, "dropoffLongitude" = $8,
        "dropoffAddress" = $9, "dropoffRoadAddress" = $9, "dropoffLocationSource" = 'MAP_PIN', "dropoffConfirmedAt" = now(),
        "locationConsentVersion" = COALESCE("locationConsentVersion", '2026-07-21'), "updatedAt" = now()
      WHERE id = $1`,
    requestId, label, plat, plng, pname, dName, dLat, dLng, dName,
  );

  // 3) 확정본에서 빠져 있었으면 되돌린다(이용 상태로).
  await prisma.$executeRawUnsafe(
    `UPDATE "SeasonalShuttleRoster" SET "removedAt" = NULL, "removedReason" = NULL, "updatedAt" = now()
      WHERE "shuttleRequestId" = $1 AND "removedAt" IS NOT NULL`,
    requestId,
  );

  // 4) 청구 전(paymentId NULL)이면 셔틀비 0원 + 항목가·신청 합계 재계산.
  await prisma.$executeRawUnsafe(
    `UPDATE "SpecialProgramApplicationItem"
        SET "shuttleFeeSnapshot" = 0, "priceSnapshot" = "tuitionPriceSnapshot", "updatedAt" = now()
      WHERE id = (SELECT "applicationItemId" FROM "SpecialProgramShuttleRequest" WHERE id = $1)
        AND "paymentId" IS NULL`,
    requestId,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "SpecialProgramApplication" a
        SET "totalPriceSnapshot" = (SELECT COALESCE(SUM(i."priceSnapshot"), 0) FROM "SpecialProgramApplicationItem" i WHERE i."applicationId" = a.id),
            "updatedAt" = now()
      WHERE a.id = (SELECT it."applicationId" FROM "SpecialProgramApplicationItem" it
                      JOIN "SpecialProgramShuttleRequest" r ON r."applicationItemId" = it.id WHERE r.id = $1)`,
    requestId,
  );
  return { ok: true };
}

/** 되돌리기(제외 취소). 원장이 실수로 뺐을 때 복구용. */
export async function restoreConfirmedShuttleRosterRow(rosterId: string) {
  await requireRosterOwner();
  if (!rosterId) throw new Error("rosterId required");
  const changed = await prisma.$executeRawUnsafe(
    `UPDATE "SeasonalShuttleRoster"
        SET "removedAt" = NULL, "removedReason" = NULL, "updatedAt" = now()
      WHERE id = $1`,
    rosterId,
  );
  return { ok: true, changed };
}

/**
 * 확정 "메타 정보"만 돌려준다 — 몇 건이 확정돼 있고, 언제 확정했는지.
 *
 * ⚠️ 이름을 일부러 get* 으로 짓지 않았다. 이 파일의 규칙은 "명단을 읽는 출구(get*)는 딱 2개"이고
 *    (회귀 테스트가 그 개수를 지킨다), 이 함수는 명단이 아니라 화면 배너에 쓸 부가 정보만 준다.
 *
 * 확정일시는 확정본 행의 **최소 confirmedAt**(DDL의 `"confirmedAt" TIMESTAMPTZ NOT NULL DEFAULT now()`)을 쓴다.
 * 나중에 추가된 행이 아니라 "원장이 처음 확정을 누른 시각"이 화면에 보여야 하기 때문이다.
 * 인증을 걸지 않는 이유는 조회 함수와 같다(호출부가 기존 가드를 유지한다).
 */
export async function shuttleRosterConfirmationInfo(
  seasonId?: string | null,
): Promise<{ confirmed: boolean; count: number; confirmedAt: Date | null }> {
  const scope = seasonScope({ roster: "sr", season: "s" }, seasonId);
  try {
    // ★ confirmed 를 "살아 있는 행 수 > 0"으로 판정하면 안 된다. 전원 제외 상태에서 count가 0이 되어
    //   화면이 다시 "확정 전"으로 보이고, 원장은 이미 확정한 명단을 또 확정하려 들게 된다.
    //   명단 조회(getConfirmedShuttleRoster)와 완전히 같은 기준으로 판정한다.
    const confirmed = (await confirmedModeEnabled()) && (await confirmedRosterExists(seasonId));
    const rows = await prisma.$queryRawUnsafe<RawRow[]>(
      `SELECT count(*)::int AS "count", min(sr."confirmedAt") AS "confirmedAt"
         FROM "SeasonalShuttleRoster" sr
         JOIN "SpecialProgramSeason" s ON s.id = sr."seasonId"
        WHERE sr."removedAt" IS NULL
          AND ${scope.where}`,
      ...scope.params,
    );
    return { confirmed, count: num(rows[0]?.count) ?? 0, confirmedAt: dt(rows[0]?.confirmedAt) };
  } catch {
    // 테이블이 아직 없는 환경(구버전 DB)에서는 "확정 안 됨"으로 본다. 화면이 죽는 것보다 안전하다.
    return { confirmed: false, count: 0, confirmedAt: null };
  }
}

/**
 * 이 셔틀 신청이 이미 확정본에 들어가 있는가.
 *
 * 왜 필요한가(R-5): 저장 요청을 확정본으로 보낼지 원본으로 보낼지를 **클라이언트가 보낸 값으로**
 * 판단하면, 확정 전에 열어 둔 탭이 확정 후에 저장하는 순간 rosterId가 없어서 원본 신청서가 수정된다.
 * 화면엔 "저장됨"이 뜨지만 기사님 명단(확정본)은 그대로라 아이가 옛 주소에서 기다리게 된다.
 * → 원본을 고치기 직전에 서버가 직접 확인한다.
 */
export async function isShuttleRequestConfirmed(shuttleRequestId: string): Promise<boolean> {
  if (!shuttleRequestId) return false;
  if (!(await confirmedModeEnabled())) return false; // 킬 스위치가 꺼져 있으면 원본이 정본이다.
  try {
    const rows = await prisma.$queryRawUnsafe<RawRow[]>(
      `SELECT 1 AS one
         FROM "SeasonalShuttleRoster"
        WHERE "shuttleRequestId" = $1
          AND "removedAt" IS NULL
        LIMIT 1`,
      shuttleRequestId,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * 셔틀 신청 id로 확정본 행을 찾아 지도 핀을 찍는다(T-1).
 *
 * 왜 필요한가: 노선 편성 화면(/admin/shuttle)의 미배정 명단은 게이트웨이(= 확정본)에서 읽는데,
 * 핀 저장은 원본 테이블에만 쓰고 있었다. 그래서 확정 후에는 핀을 찍어도 "저장했습니다" 토스트만 뜨고
 * 좌표는 그대로였다(에러도 로그도 없는 조용한 no-op). **읽는 곳과 쓰는 곳이 갈리면 반드시 이렇게 된다.**
 *
 * 확정본이 없으면 `applied:false`를 돌려주고, 호출부가 기존대로 원본에 저장한다.
 * @param label 화면이 함께 보낸 표시 이름. 있으면 라벨을 이 값으로 덮는다(노선 편성 화면의 기존 동작).
 */
export async function applyConfirmedRosterPin(
  shuttleRequestId: string,
  kind: "pickup" | "dropoff",
  pin: ConfirmedRosterPin,
  label?: string | null,
): Promise<{ applied: boolean }> {
  if (!shuttleRequestId) return { applied: false };
  if (!(await confirmedModeEnabled())) return { applied: false };

  let rosterId: string | null = null;
  try {
    const rows = await prisma.$queryRawUnsafe<RawRow[]>(
      `SELECT id FROM "SeasonalShuttleRoster"
        WHERE "shuttleRequestId" = $1 AND "removedAt" IS NULL
        ORDER BY "confirmedAt" DESC
        LIMIT 1`,
      shuttleRequestId,
    );
    rosterId = str(rows[0]?.id);
  } catch {
    return { applied: false }; // 테이블이 없는 구버전 DB → 기존 경로 유지
  }
  if (!rosterId) return { applied: false };

  const patch: ConfirmedRosterPatch = kind === "pickup"
    ? { pickupPin: pin, ...(str(label) ? { pickupLocation: str(label) } : {}) }
    : { dropoffPin: pin, ...(str(label) ? { dropoffLocation: str(label) } : {}) };
  await updateConfirmedShuttleRosterRow(rosterId, patch);
  return { applied: true };
}
