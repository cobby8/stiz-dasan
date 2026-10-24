import { prisma } from "@/lib/prisma";
import {
  buildRegularShuttleRoster,
  weekdayNameFromDate,
  DOW_NAMES,
  type RegularShuttleDirection,
  type RegularShuttlePlace,
  type RegularShuttleRawRider,
  type RegularShuttleRosterResult,
} from "./shuttleRosterLogic";

/**
 * 정규 수업 셔틀 "라이더 명단" 조회 (Phase 0) — 서버 · 읽기 전용.
 *
 * ▶ 2026-07-27 소스 전환: 신청서(EnrollmentApplication) → **지오코딩된 구글시트(RegularShuttleStop)**.
 *   (2026-10-02 시트 가져오기 종료 — 지금은 「셔틀 명단」 탭에서 앱이 직접 편집하는 RegularShuttleStop 이 소스다.)
 *   이유: 실제 정규 셔틀 이용자(주 79명·5요일)는 RegularShuttleStop 에 텍스트 명단으로 있고,
 *   신청서 좌표는 거의 0이라 기존 소스로는 배차 화면이 비었다. 시트는 좌표를 채우면(별도 지오코딩
 *   작업) 배차가 실데이터로 작동한다. → 라이더 소스를 시트로 단순 교체(하이브리드 아님).
 *
 * 매핑 규칙:
 *   - 요일: RegularShuttleStop.weekday(Int, 0=일 … 6=토) ↔ Class.dayOfWeek 문자열(DOW_NAMES 인덱스).
 *   - 방향: BOARD(승차)=PICKUP(등원), ALIGHT(하차)=DROPOFF(하원).
 *           PIVOT('하차/승차'=학원 경유)·RETURN(복귀)은 개별 학생 라이더가 아니라 운영 정차라 제외.
 *   - 좌표: 그 정차 행의 latitude/longitude 를 등원·하원 위치 양쪽에 담는다(방향별로 이미 필터되므로 동일).
 *   - 학생 연결: studentName(공백 무시) → Student(name 매칭, mergedIntoStudentId IS NULL).
 *               학부모 전화(User/Guardian)를 보조 tiebreaker 로 써 동명이인 오매칭을 줄인다.
 *   - studentId: 매칭 성공=실제 Student.id, 실패='stop:'+행id(하위 배차·reconcile 식별키 유일성 보존.
 *                실제 Student.id(uuid)와 절대 충돌하지 않으므로 학부모 ETA 오매칭도 없음).
 *   - 좌표 없는 행(지오코딩 전): buildRegularShuttleRoster 에서 unassigned 로 분리(배차는 좌표 있는 것만).
 *
 * 반환 shape 는 종전과 동일한 RegularShuttleRosterResult 라, Phase 1(computeRegularDispatch)·
 * Phase 2(배차 화면)·Phase 3(학부모 확정시간)·reconcile 이 무변경으로 그대로 소비한다.
 *
 * ⚠️ PgBouncer 트랜잭션 모드 → $queryRawUnsafe 고정(prepared statement 우회).
 * 권한: 내부 roster 조회라 인증하지 않는다. 소비처(화면·API)가 기존 가드를 유지한다(IDOR 무관).
 */

export type GetRegularShuttleRidersOptions = {
  direction: RegularShuttleDirection;
  /** 차량표 적용 월('YYYY-MM'). 없으면 저장된 최신 월. */
  serviceMonth?: string;
  /** Class.dayOfWeek 문자열("Mon" 등). date보다 우선한다. */
  dayOfWeek?: string;
  /** 'YYYY-MM-DD'. dayOfWeek 미지정 시 이 날짜의 요일로 계산한다. */
  date?: string;
};

// raw SQL 한 행. 컬럼명이 SQL 문자열 안에 있어 정적 타입을 붙일 수 없다.
type RawRow = Record<string, unknown>;

function str(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t : null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 방향(PICKUP/DROPOFF) → RegularShuttleStop.direction(BOARD/ALIGHT). */
function stopDirectionFor(direction: RegularShuttleDirection): "BOARD" | "ALIGHT" {
  return direction === "PICKUP" ? "BOARD" : "ALIGHT";
}

/** Class.dayOfWeek 문자열("Mon" 등) → RegularShuttleStop.weekday(0=일 … 6=토). 없으면 null. */
function weekdayIndexFromName(dayOfWeek: string): number | null {
  const idx = DOW_NAMES.indexOf(dayOfWeek as (typeof DOW_NAMES)[number]);
  return idx >= 0 ? idx : null;
}

/** '17:00~18:00' 같은 수업시간 텍스트에서 시작/종료('HH:MM')를 뽑는다. 형식이 다르면 null. */
function splitClassTime(v: unknown): { start: string | null; end: string | null } {
  const t = str(v);
  if (!t) return { start: null, end: null };
  const times = t.match(/\d{1,2}:\d{2}/g);
  if (!times || times.length === 0) return { start: null, end: null };
  const pad = (s: string) => s.replace(/^(\d):/, "0$1:");
  return { start: pad(times[0]), end: times[1] ? pad(times[1]) : null };
}

/** 명단 정차 한 행(RawRow)을 방향 반영 전 RawRider 로 옮긴다. 등원·하원 위치 모두 그 정차 좌표로 채운다. */
function toRawRider(r: RawRow): RegularShuttleRawRider {
  const lat = num(r.latitude);
  const lng = num(r.longitude);
  const stopName = str(r.stopName);
  // 등원·하원 위치를 같은 정차 좌표로 채운다(행 자체가 이미 방향별로 필터돼 있으므로 동일 위치가 맞다).
  const stopPlace: RegularShuttlePlace = {
    location: stopName,
    address: null,
    roadAddress: null,
    latitude: lat,
    longitude: lng,
    placeId: null,
  };
  const { start, end } = splitClassTime(r.classTime);
  return {
    studentId: String(r.studentId), // 실제 Student.id 또는 'stop:'+행id (SQL 에서 COALESCE)
    // 이 라이더를 만든 명단 정차행 id — 기사님 화면이 저장 노선을 탑승체크 키로 되돌릴 때 쓴다.
    stopRowId: str(r.stopRowId),
    studentName: String(r.studentName ?? ""),
    childGrade: str(r.childGrade),
    childPhone: str(r.childPhone),
    parentName: null, // 명단에는 학부모 이름이 없다(전화만 있음).
    parentPhone: str(r.parentPhone),
    classId: "", // 셔틀 명단엔 반(Class) 개념이 없다. 식별에 쓰이지 않으므로 빈 값.
    className: str(r.classTime), // 표시용으로 수업시간 텍스트를 반 이름 자리에 둔다.
    dayOfWeek: String(r.dayOfWeek ?? ""),
    classStart: start,
    classEnd: end,
    applicationId: null, // 신청서 연결 없음(학생 상세 모달 키는 studentId 로 대체).
    shuttleNeeded: true, // 셔틀 명단에 있으면 이용자다.
    pickupTime: str(r.arriveTime), // 명단의 도착 예정시각(참고값).
    pickup: stopPlace,
    dropoff: stopPlace,
  };
}

/**
 * 특정 요일(또는 날짜) × 방향 기준으로 정규 셔틀 라이더 명단을 반환한다.
 *
 * 소스: RegularShuttleStop(셔틀 명단 — 앱에서 직접 편집).
 *   - weekday(그 요일) + direction(BOARD/ALIGHT) + studentName 있는 행만 뽑는다.
 *   - 각 행을 라이더 1명으로 만들고 studentName 으로 Student 를 best-effort 매칭한다.
 * 좌표 없는 행(지오코딩 전)은 buildRegularShuttleRoster 에서 unassigned 로 분리된다(경고).
 */
export async function getRegularShuttleRiders(
  opts: GetRegularShuttleRidersOptions,
  db: Pick<typeof prisma, "$queryRawUnsafe"> = prisma,
): Promise<RegularShuttleRosterResult> {
  const dayOfWeek = opts.dayOfWeek ?? (opts.date ? weekdayNameFromDate(opts.date) : null);
  if (!dayOfWeek) {
    throw new Error("getRegularShuttleRiders: dayOfWeek 또는 date 가 필요합니다.");
  }
  const weekdayIdx = weekdayIndexFromName(dayOfWeek);
  if (weekdayIdx == null) {
    throw new Error(`getRegularShuttleRiders: 알 수 없는 요일 '${dayOfWeek}'`);
  }
  const stopDir = stopDirectionFor(opts.direction);

  const rows = await db.$queryRawUnsafe<RawRow[]>(
    `SELECT
        -- 매칭된 Student.id, 없으면 정차 행 id 에 접두사('stop:')를 붙여 유일한 식별키를 보장한다.
        -- (접두사 덕분에 실제 Student.id(uuid)와 절대 충돌하지 않아 학부모 ETA 오매칭이 없다.)
        COALESCE(rss."studentId", st."id", 'stop:' || rss."id") AS "studentId",
        rss."id"                                AS "stopRowId",
        rss."studentName"                       AS "studentName",
        st."grade"                              AS "childGrade",
        COALESCE(rss."studentPhone", st."phone") AS "childPhone",
        rss."parentPhone"                       AS "parentPhone",
        rss."classTime"                         AS "classTime",
        rss."arriveTime"                        AS "arriveTime",
        rss."stopName"                          AS "stopName",
        rss."latitude"                          AS "latitude",
        rss."longitude"                         AS "longitude",
        rss."sortOrder"                         AS "sortOrder",
        $3                                      AS "dayOfWeek"
       FROM "RegularShuttleStop" rss
       -- studentName 으로 Student 를 best-effort 매칭(공백 무시·대소문자 무시).
       -- 학부모 전화(User/Guardian)가 일치하는 학생을 우선해 동명이인 오매칭을 줄인다.
       LEFT JOIN LATERAL (
         SELECT s."id", s."grade", s."phone"
           FROM "Student" s
           JOIN "User" u ON u."id" = s."parentId"
          WHERE rss."studentId" IS NULL
            AND s."mergedIntoStudentId" IS NULL
            AND regexp_replace(lower(s."name"), '\\s', '', 'g')
              = regexp_replace(lower(rss."studentName"), '\\s', '', 'g')
          ORDER BY
            CASE WHEN rss."parentPhone" IS NOT NULL AND (
              regexp_replace(COALESCE(u."phone", ''), '[^0-9]', '', 'g')
                = regexp_replace(rss."parentPhone", '[^0-9]', '', 'g')
              OR EXISTS (
                SELECT 1 FROM "Guardian" g
                 WHERE g."studentId" = s."id"
                   AND regexp_replace(COALESCE(g."phone", ''), '[^0-9]', '', 'g')
                     = regexp_replace(rss."parentPhone", '[^0-9]', '', 'g')
              )
            ) THEN 0 ELSE 1 END,
            s."createdAt" ASC
          LIMIT 1
       ) st ON true
      WHERE rss."weekday" = $1
        AND rss."direction" = $2
        AND rss."serviceMonth" = COALESCE($4, (SELECT MAX("serviceMonth") FROM "RegularShuttleStop"))
        AND rss."studentName" IS NOT NULL
        AND btrim(rss."studentName") <> ''
      ORDER BY rss."sortOrder" ASC, rss."stopName" ASC`,
    weekdayIdx,
    stopDir,
    dayOfWeek,
    opts.serviceMonth ?? null,
  );

  const raw = rows.map(toRawRider);
  return buildRegularShuttleRoster(raw, opts.direction, dayOfWeek);
}

/**
 * 정규 셔틀 이용자가 존재하는 요일 목록(Class.dayOfWeek)을 돌려준다(요일 네비용).
 * 소스: RegularShuttleStop — 학생 정차(BOARD/ALIGHT, studentName 있음)가 하나라도 있는 요일.
 * 좌표 유무는 보지 않는다(지오코딩 전이라도 요일 탭은 떠야 한다).
 */
export async function getRegularShuttleWeekdays(serviceMonth?: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<RawRow[]>(
    `SELECT DISTINCT rss."weekday" AS "weekday"
      FROM "RegularShuttleStop" rss
      WHERE rss."direction" IN ('BOARD', 'ALIGHT')
        AND rss."serviceMonth" = COALESCE($1, (SELECT MAX("serviceMonth") FROM "RegularShuttleStop"))
        AND rss."studentName" IS NOT NULL
        AND btrim(rss."studentName") <> ''`,
    serviceMonth ?? null,
  );
  // weekday(0=일 … 6=토) → 요일명. 월(Mon)~일(Sun) 순으로 정렬해 돌려준다(요일 탭 표시 순서).
  const ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const present = new Set(
    rows
      .map((r): string | null => {
        const idx = Number(r.weekday);
        return Number.isInteger(idx) && idx >= 0 && idx < 7 ? DOW_NAMES[idx] : null;
      })
      .filter((v): v is string => v != null),
  );
  return ORDER.filter((d) => present.has(d));
}
