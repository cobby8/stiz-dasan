import { prisma } from "@/lib/prisma";
import { weekdayInSeoul } from "@/lib/seasonal/planning";
// «새 기능 시즌인가» 판정은 공용 함수 하나로(공개 신청·관리자 승인·보강과 같은 기준)
import { usesPeriodOrDateFeatures } from "@/lib/seasonal/period-pricing";
// 반 이름 + 횟수(«초등 고학년 주2회») — 반 이름에서 횟수를 빼도 코드로 구분한다(2026-11-19)
import { offeringTitleWithFrequency } from "@/lib/seasonal/offering-groups";

/** raw 쿼리의 불리언(드라이버에 따라 true 또는 "true")을 JS 불리언으로. */
function sqlBool(value: unknown): boolean {
  return value === true || value === "true" || value === "t";
}

// 방학특강 출석 라이브러리 — 모든 쿼리는 PgBouncer 트랜잭션 모드 호환을 위해 $queryRawUnsafe 사용.
// 출석은 학생(Student) 전환 여부와 무관하게 SpecialProgramEnrollmentDate 행에 직접 기록한다.

export const SEASONAL_ATTENDANCE_STATUSES = ["PRESENT", "LATE", "ABSENT", "EXCUSED"] as const;
export type SeasonalAttendanceStatus = (typeof SEASONAL_ATTENDANCE_STATUSES)[number];
const VALID_ATTENDANCE = new Set<string>(SEASONAL_ATTENDANCE_STATUSES);

// 신청 요일 키(MON~SUN)를 한글 한 글자로 바꾸는 표. 화면 뱃지(예: "월·수")에 사용한다.
const WEEKDAY_KO_BY_KEY: Record<string, string> = {
  MON: "월", TUE: "화", WED: "수", THU: "목", FRI: "금", SAT: "토", SUN: "일",
};

// DB의 selectedWeekdays(TEXT[])를 안전하게 문자열 배열로 정리한다. (null·잘못된 값 방어)
function weekdayKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim().toUpperCase()).filter((v) => v in WEEKDAY_KO_BY_KEY);
}

// ["MON","WED"] → "월·수". 값이 없으면 null을 돌려 화면에서 뱃지를 숨긴다.
function weekdayLabel(keys: string[]): string | null {
  if (keys.length === 0) return null;
  return keys.map((k) => WEEKDAY_KO_BY_KEY[k]).join("·");
}

// DB 의 selectedDates(TEXT[])를 깨끗한 날짜 문자열 배열로(null·빈 값 방어). 기존 신청서는 빈 배열.
function cleanDateList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? "").trim()).filter((v) => v.length > 0);
}

function seoulParts(value: Date | string) {
  const d = typeof value === "string" ? new Date(value) : value;
  const fmt = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  // 요일 키는 기존 KST 유틸(weekdayInSeoul)을 재사용해 서울시간 기준으로 계산한다.
  const weekdayKey = weekdayInSeoul(d);
  return {
    dateLabel: `${Number(parts.month)}/${Number(parts.day)}`,
    // 한글 요일 라벨도 서울시간 기준 요일 키에서 뽑아 Intl 로케일 차이에 흔들리지 않게 한다.
    dayLabel: WEEKDAY_KO_BY_KEY[weekdayKey] ?? (parts.weekday || "").replace("요일", ""),
    weekdayKey,
    timeLabel: `${parts.hour}:${parts.minute}`,
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function num(v: unknown) { return v == null ? 0 : Number(v); }

// 특강(반) 전체 승인 학생 수 — 날짜별 명단과 같은 기준(승인된 신청항목 + 취소 아닌 정규 배정)으로 센다.
// 학생마다 신청 요일이 달라 "이 날 명단 인원"은 이 값보다 작을 수 있다. 그걸 화면에서 설명하기 위한 값.
async function countApprovedStudents(offeringId: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ total: unknown }>>(
    `SELECT COUNT(DISTINCT e."applicationItemId") AS total
       FROM "SpecialProgramEnrollmentDate" e
       JOIN "SpecialProgramSessionDate" sd ON sd.id = e."sessionDateId"
       JOIN "SpecialProgramApplicationItem" it ON it.id = e."applicationItemId"
      WHERE sd."offeringId" = $1
        AND e.status <> 'CANCELLED'
        AND e.kind = 'REGULAR'
        AND it.status = 'APPROVED'`,
    offeringId,
  );
  return num(rows[0]?.total);
}

// 요일 순서 고정 — 아래 집계 쿼리의 VALUES 목록과 화면 표시 순서를 같게 맞춘다.
const WEEKDAY_ORDER = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

// "그 요일에 코트로 실제 들어오는 전체 인원"과 정원.
// byWeekday 예: { MON: 15, TUE: 11, WED: 13, ... } / capacity: 12
export type SeasonalCourtOccupancy = {
  capacity: number | null;      // 운영 정원(= 한 요일에 코트에 들어올 수 있는 최대 인원)
  offeringCount: number;        // 이 코트를 함께 쓰는 반(형제 반) 개수. 1이면 단독 반.
  byWeekday: Record<string, number>;
  /**
   * 2026-11-18 «기간이 섞인 시즌» 표시.
   * true = 이 코트 그룹에 기간 상품이 있거나, 시즌이 날짜별 선택을 켰거나, 기간·날짜를 고른 신청서가 있다.
   * 이때 byWeekday 는 «그 요일에 올 수 있는 최대 인원»이다(앞 3주만 오는 학생도 전 기간 그 요일에 센다).
   * 화면은 이 값이 true 면 «기간이 섞인 시즌은 최대 인원 기준» 안내를 띄운다. 계산 자체는 예전과 같다.
   */
  hasMixedPeriods: boolean;
};

// ── 요일별 "코트 점유 인원" 집계 ────────────────────────────────────────────────
// 왜 필요한가: 화면의 "정원"은 반(offering) 하나의 숫자가 아니라,
// route.ts의 승인 검사(ensureSpecialProgramOperationalCapacity, 551~598행)가 쓰는
// "linkedClass로 묶인 형제 반(주2회·주3회 등)을 전부 합쳐 한 요일에 코트에 들어올 수 있는 최대 인원"이다.
// 그래서 옆에 표시되는 "반 전체 N명"(반 1개 · 전체 기간)과 축이 달라 13 > 12 같은 모순이 보였다.
// 여기서는 승인 검사와 **완전히 같은 기준**으로 요일별 실제 점유 인원을 센다.
//   · 대상: 승인된 신청항목(item.status='APPROVED')
//   · 범위: linkedClassId가 있으면 같은 시즌·같은 linkedClassId의 형제 반 전체, 없으면 이 반만
//   · 요일: 학생이 고른 selectedWeekdays에 그 요일이 있으면 점유(요일 미선택 = 전 요일 등원으로 간주)
// 날짜마다 쿼리를 도는 N+1을 피하려고 7요일을 한 번에 GROUP BY로 집계한다. (SELECT 전용 · DB 변경 없음)
export async function getCourtOccupancyByWeekday(offeringId: string): Promise<SeasonalCourtOccupancy | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{
    weekday: string; occupied: unknown; offeringCount: unknown; capacity: unknown;
    dateSelectEnabled: unknown; activePeriodCount: unknown; appsUsePeriodOrDate: unknown;
  }>>(
    `WITH target AS (
        SELECT id, "seasonId", "linkedClassId", capacity
          FROM "SpecialProgramOffering"
         WHERE id = $1
      ), scope AS (
        SELECT o.id
          FROM "SpecialProgramOffering" o
          CROSS JOIN target t
         WHERE CASE
                 WHEN t."linkedClassId" IS NULL THEN o.id = t.id
                 ELSE o."seasonId" = t."seasonId" AND o."linkedClassId" = t."linkedClassId"
               END
      ), seat AS (
        SELECT item.id AS item_id, app."selectedWeekdays" AS weekdays,
               app."selectedDates" AS dates,
               app."periodStartDate" AS period_start, app."periodEndDate" AS period_end
          FROM "SpecialProgramApplicationItem" item
          JOIN scope ON scope.id = item."offeringId"
          JOIN "SpecialProgramApplication" app ON app.id = item."applicationId"
         WHERE item.status = 'APPROVED'
      ), mixed AS (
        -- 기간이 섞인 시즌인가 — SQL 은 재료 세 가지만 센다(시즌 날짜 선택 켜짐 · 그룹의 «켜진» 기간 행 수 ·
        -- 기간/날짜를 고른 승인 신청서). 판정은 아래 JS 의 공용 usesPeriodOrDateFeatures 가 한다(다른 경로와 같은 기준).
        -- 요일 집계(아래 GROUP BY)는 그대로 두고, 화면 안내용 표시만 함께 내려준다.
        SELECT
          EXISTS (
            SELECT 1 FROM "SpecialProgramSeason" season
              JOIN target t ON t."seasonId" = season.id
             WHERE season."dateSelectEnabled" = true
          ) AS date_select,
          (
            SELECT COUNT(*) FROM "SpecialProgramOfferingPeriod" p
              JOIN scope ON scope.id = p."offeringId"
             WHERE p."isActive" = true
          ) AS active_periods,
          EXISTS (
            SELECT 1 FROM seat
             WHERE COALESCE(cardinality(seat.dates), 0) > 0
                OR seat.period_start IS NOT NULL
                OR seat.period_end IS NOT NULL
          ) AS apps_use
      ), wd(day_key) AS (
        VALUES ('MON'),('TUE'),('WED'),('THU'),('FRI'),('SAT'),('SUN')
      )
      SELECT wd.day_key AS weekday,
             COUNT(DISTINCT seat.item_id) AS occupied,
             (SELECT COUNT(*) FROM scope) AS "offeringCount",
             (SELECT capacity FROM target) AS capacity,
             (SELECT date_select FROM mixed) AS "dateSelectEnabled",
             (SELECT active_periods FROM mixed) AS "activePeriodCount",
             (SELECT apps_use FROM mixed) AS "appsUsePeriodOrDate"
        FROM wd
        LEFT JOIN seat
          ON (COALESCE(cardinality(seat.weekdays), 0) = 0 OR wd.day_key = ANY(seat.weekdays))
       GROUP BY wd.day_key`,
    offeringId,
  );
  if (rows.length === 0) return null;
  const byWeekday: Record<string, number> = {};
  for (const key of WEEKDAY_ORDER) byWeekday[key] = 0;
  for (const row of rows) byWeekday[String(row.weekday)] = num(row.occupied);
  const capacityRaw = rows[0]?.capacity;
  return {
    capacity: capacityRaw == null ? null : Number(capacityRaw),
    offeringCount: num(rows[0]?.offeringCount),
    byWeekday,
    // 기간이 섞인 시즌이면 byWeekday 는 «최대 인원» — 화면 안내용(계산은 그대로)
    hasMixedPeriods: usesPeriodOrDateFeatures({
      dateSelectEnabled: sqlBool(rows[0]?.dateSelectEnabled),
      activePeriodCount: num(rows[0]?.activePeriodCount),
      applicationsUsePeriodOrDate: sqlBool(rows[0]?.appsUsePeriodOrDate),
    }),
  };
}

// 1) 화면 부트스트랩: 시즌 + 특강(offering) 목록
export async function getSeasonalAttendanceBootstrap() {
  const seasons = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title, status, "startsAt", "endsAt"
       FROM "SpecialProgramSeason"
      ORDER BY "startsAt" DESC`,
  );
  const offerings = await prisma.$queryRawUnsafe<any[]>(
    `SELECT o.id, o."seasonId", o.title, o.code, o.capacity, o."targetGrades", o."instructorName", o."linkedClassId",
            (SELECT COUNT(*) FROM "SpecialProgramSessionDate" sd WHERE sd."offeringId" = o.id) AS "dateCount",
            (SELECT COUNT(*) FROM "SpecialProgramEnrollmentDate" e
               JOIN "SpecialProgramSessionDate" sd2 ON sd2.id = e."sessionDateId"
              WHERE sd2."offeringId" = o.id AND e.status = 'SCHEDULED' AND e.kind = 'REGULAR') AS "enrolledSlots"
       FROM "SpecialProgramOffering" o
      WHERE o.status IN ('OPEN','CLOSED')
      ORDER BY o."displayOrder" ASC, o."createdAt" ASC`,
  );
  return {
    seasons: seasons.map((s) => ({ id: s.id, title: s.title, status: s.status, startsAt: s.startsAt, endsAt: s.endsAt })),
    offerings: offerings.map((o) => ({
      // 반 이름에서 «주N회»를 뺐어도(«초등 고학년») 코드의 횟수를 붙여 반을 구분한다(2026-11-19)
      id: o.id, seasonId: o.seasonId, title: offeringTitleWithFrequency(o),
      capacity: o.capacity == null ? null : Number(o.capacity),
      targetGrades: o.targetGrades ?? null, instructorName: o.instructorName ?? null,
      linkedClassId: o.linkedClassId ?? null,
      dateCount: num(o.dateCount), enrolledSlots: num(o.enrolledSlots),
    })),
  };
}

// 1-1) 상단 탭 "보강 관리" 빨간 뱃지용 — 승인 대기(REQUESTED) 보강 신청 건수만 센다.
// 목록 전체(listMakeups)를 부르면 무거우므로 COUNT만 조회한다. 조회 전용(DB 변경 없음).
// 보관(ARCHIVED) 시즌은 더 이상 처리할 수 없는 건이라 제외 → 뱃지가 영구히 남는 것을 방지한다.
export async function countPendingMakeups(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ total: unknown }>>(
    `SELECT COUNT(*) AS total
       FROM "SpecialProgramMakeup" m
       JOIN "SpecialProgramOffering" o ON o.id = m."offeringId"
       JOIN "SpecialProgramSeason" s ON s.id = o."seasonId"
      WHERE m.status = 'REQUESTED'
        AND s.status <> 'ARCHIVED'`,
  );
  return num(rows[0]?.total);
}

// 2) 특강 회차(날짜)별 보드 — 정원/출결 요약
export async function getOfferingDateBoard(offeringId: string) {
  const offeringRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title, code, capacity, "instructorName" FROM "SpecialProgramOffering" WHERE id = $1 LIMIT 1`,
    offeringId,
  );
  const offering = offeringRows[0];
  if (!offering) return { offering: null, dates: [] };
  const capacity = offering.capacity == null ? null : Number(offering.capacity);

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT sd.id, sd."startsAt", sd."endsAt", sd.location,
            COUNT(e.id) FILTER (WHERE e.status = 'SCHEDULED') AS scheduled,
            COUNT(e.id) FILTER (WHERE e.status = 'SCHEDULED' AND e.kind = 'MAKEUP') AS makeup,
            COUNT(e.id) FILTER (WHERE e."attendanceStatus" = 'PRESENT') AS present,
            COUNT(e.id) FILTER (WHERE e."attendanceStatus" = 'LATE') AS late,
            COUNT(e.id) FILTER (WHERE e."attendanceStatus" = 'ABSENT') AS absent,
            COUNT(e.id) FILTER (WHERE e."attendanceStatus" = 'EXCUSED') AS excused,
            COUNT(e.id) FILTER (WHERE e.status = 'SCHEDULED' AND e."attendanceStatus" IS NULL) AS unchecked
       FROM "SpecialProgramSessionDate" sd
       LEFT JOIN "SpecialProgramEnrollmentDate" e ON e."sessionDateId" = sd.id AND e.status <> 'CANCELLED'
      WHERE sd."offeringId" = $1
      GROUP BY sd.id, sd."startsAt", sd."endsAt", sd.location
      ORDER BY sd."startsAt" ASC`,
    offeringId,
  );

  // 반 전체 승인 인원(요일 무관)과, 요일별 코트 점유 인원을 함께 조회한다.
  // 두 값은 기준이 다르므로(반 1개/전체기간 vs 형제 반 합산/하루) 화면에서 구분해 보여준다.
  // 서로 의존하지 않는 조회라 병렬로 돌려 응답 시간을 늘리지 않는다.
  const [totalApprovedStudents, courtOccupancy] = await Promise.all([
    countApprovedStudents(offeringId),
    getCourtOccupancyByWeekday(offeringId),
  ]);

  const todayYmd = seoulParts(new Date()).ymd;
  const dates = rows.map((r, idx) => {
    const p = seoulParts(r.startsAt);
    const end = seoulParts(r.endsAt);
    const scheduled = num(r.scheduled);
    const checked = num(r.present) + num(r.late) + num(r.absent) + num(r.excused);
    let state: "DONE" | "LIVE" | "PLANNED";
    if (p.ymd < todayYmd) state = "DONE";
    else if (p.ymd === todayYmd) state = "LIVE";
    else state = "PLANNED";
    return {
      sessionDateId: r.id, round: idx + 1,
      dateLabel: p.dateLabel, dayLabel: p.dayLabel, weekdayKey: p.weekdayKey,
      startTime: p.timeLabel, endTime: end.timeLabel,
      ymd: p.ymd, location: r.location ?? null,
      capacity, scheduled, makeup: num(r.makeup),
      // 그날(요일) 코트에 실제로 들어오는 전체 인원 — 형제 반 합산 기준. 정원과 직접 비교할 수 있는 값.
      courtOccupied: courtOccupancy ? (courtOccupancy.byWeekday[p.weekdayKey] ?? 0) : null,
      courtCapacity: courtOccupancy?.capacity ?? capacity,
      present: num(r.present), late: num(r.late), absent: num(r.absent), excused: num(r.excused),
      unchecked: num(r.unchecked), checked, state,
    };
  });
  return {
    offering: {
      id: offering.id, title: offeringTitleWithFrequency(offering), capacity,
      instructorName: offering.instructorName ?? null,
      totalApprovedStudents, // 반 전체 승인 학생 수(요일 무관)
      courtOfferingCount: courtOccupancy?.offeringCount ?? 1, // 이 코트를 함께 쓰는 반 개수
    },
    totalApprovedStudents,
    courtOccupancy, // 요일별 코트 점유 인원 전체(필요 시 화면에서 재사용)
    dates,
  };
}

// 3) 특정 날짜(회차) 명단
export async function getDateRoster(sessionDateId: string) {
  const info = await prisma.$queryRawUnsafe<any[]>(
    `SELECT sd.id, sd."startsAt", sd."endsAt", sd.location, o.id AS "offeringId", o.title AS "offeringTitle", o.code AS "offeringCode",
            o.capacity, o."instructorName"
       FROM "SpecialProgramSessionDate" sd
       JOIN "SpecialProgramOffering" o ON o.id = sd."offeringId"
      WHERE sd.id = $1 LIMIT 1`,
    sessionDateId,
  );
  const meta = info[0];
  if (!meta) return { date: null, rows: [] };

  // 명단 기준: 승인된 신청항목(it.status='APPROVED') + 취소되지 않은 좌석.
  // 승인 시 좌석이 자동 생성되므로, 나중에 거절/취소로 바뀌어도 좌석은 남는다(삭제 경로 없음).
  // 신청항목 상태를 같이 걸러야 그 학생이 출석부에서 빠지고, 위 countApprovedStudents 와 기준이 일치한다.
  // 보강(kind='MAKEUP') 좌석도 결석한 정규 좌석과 같은 신청항목을 가리키므로 승인 상태면 그대로 표시된다.
  //
  // ★ 코트 전체 명단: 카드의 "코트 전체 N명"(getCourtOccupancyByWeekday) 과 축을 맞춘다.
  //   한 회차(sessionDate)만 보면 그 반 좌석만 나와 "이 반 6명 · 코트 전체 15명" 처럼 명단과 카드가 어긋난다.
  //   그래서 같은 코트(linkedClass가 있으면 같은 시즌·같은 linkedClass의 형제 반, 없으면 이 반)에서
  //   **같은 KST 날짜**에 열리는 모든 형제 회차의 좌석을 한 명단으로 합친다. 학생별 반은 rowOfferingTitle 로 구분한다.
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `WITH target_sd AS (
        SELECT sd.id,
               (sd."startsAt" AT TIME ZONE 'Asia/Seoul')::date AS kst_date,
               o.id AS offering_id, o."seasonId", o."linkedClassId"
          FROM "SpecialProgramSessionDate" sd
          JOIN "SpecialProgramOffering" o ON o.id = sd."offeringId"
         WHERE sd.id = $1
      ), scope AS (
        SELECT o.id
          FROM "SpecialProgramOffering" o
          CROSS JOIN target_sd t
         WHERE CASE
                 WHEN t."linkedClassId" IS NULL THEN o.id = t.offering_id
                 ELSE o."seasonId" = t."seasonId" AND o."linkedClassId" = t."linkedClassId"
               END
      ), sibling_dates AS (
        SELECT sd.id
          FROM "SpecialProgramSessionDate" sd
          JOIN scope ON scope.id = sd."offeringId"
          CROSS JOIN target_sd t
         WHERE (sd."startsAt" AT TIME ZONE 'Asia/Seoul')::date = t.kst_date
      )
      SELECT e.id AS "enrollmentDateId", e.kind, e.status, e."attendanceStatus", e."arrivedAt", e."attendanceNote",
             e."sessionDateId",
             it.id AS "itemId", a."childName", a."childGrade", a."childSchool", a."parentName", a."parentPhone",
             a."selectedWeekdays",
             a."selectedDates", a."periodLabel",
             o2.title AS "rowOfferingTitle", o2.code AS "rowOfferingCode",
             (sd2.id = $1) AS "isThisOffering",
             mk."absentSessionDateId", absd."startsAt" AS "originStartsAt"
        FROM "SpecialProgramEnrollmentDate" e
        JOIN sibling_dates sib ON sib.id = e."sessionDateId"
        JOIN "SpecialProgramSessionDate" sd2 ON sd2.id = e."sessionDateId"
        JOIN "SpecialProgramOffering" o2 ON o2.id = sd2."offeringId"
        JOIN "SpecialProgramApplicationItem" it ON it.id = e."applicationItemId"
        JOIN "SpecialProgramApplication" a ON a.id = it."applicationId"
        LEFT JOIN "SpecialProgramMakeup" mk ON mk.id = e."makeupId"
        LEFT JOIN "SpecialProgramSessionDate" absd ON absd.id = mk."absentSessionDateId"
       WHERE e.status <> 'CANCELLED'
         AND it.status = 'APPROVED'
       -- 원장 지시(2026-08-06): 출석부는 반·보강생으로 묶지 말고 학생 이름 오름차순 한 줄로 본다.
       -- 반이 바뀔 때마다 이름이 처음부터 다시 시작해 "정렬이 안 된 것처럼" 보였다.
       -- 어느 반인지는 각 행의 반 배지로 이미 구분된다.
       -- 동명이인은 순서가 흔들리지 않게 id 로 고정한다.
       ORDER BY a."childName" ASC, e.id ASC`,
    sessionDateId,
  );

  const p = seoulParts(meta.startsAt);
  const end = seoulParts(meta.endsAt);
  // 이 반의 전체 승인 인원 — 명단 인원(요일이 맞는 학생만)과 비교해 오해를 막는 안내에 쓴다.
  // 여기에 더해 "그날 코트 전체 인원"도 함께 조회한다(정원과 같은 기준). 병렬 조회로 지연을 늘리지 않는다.
  const [totalApprovedStudents, courtOccupancy] = await Promise.all([
    countApprovedStudents(meta.offeringId),
    getCourtOccupancyByWeekday(meta.offeringId),
  ]);
  const capacity = meta.capacity == null ? null : Number(meta.capacity);
  return {
    date: {
      sessionDateId: meta.id, offeringId: meta.offeringId, offeringTitle: offeringTitleWithFrequency({ title: meta.offeringTitle, code: meta.offeringCode }),
      dateLabel: p.dateLabel, dayLabel: p.dayLabel, weekdayKey: p.weekdayKey,
      startTime: p.timeLabel, endTime: end.timeLabel,
      location: meta.location ?? null, capacity,
      instructorName: meta.instructorName ?? null,
      totalApprovedStudents,
      // 이 날짜 요일의 코트 전체 인원 / 정원 — 반 명부(totalApprovedStudents)와 기준이 다르다.
      courtOccupied: courtOccupancy ? (courtOccupancy.byWeekday[p.weekdayKey] ?? 0) : null,
      courtCapacity: courtOccupancy?.capacity ?? capacity,
      courtOfferingCount: courtOccupancy?.offeringCount ?? 1,
    },
    totalApprovedStudents,
    courtOccupancy,
    rows: rows.map((r) => {
      const selectedWeekdays = weekdayKeys(r.selectedWeekdays);
      // 날짜별 선택 신청서는 요일 대신 «날짜 선택 N회»로 보여 준다(2026-11-18).
      const selectedDates = cleanDateList(r.selectedDates);
      return {
        enrollmentDateId: r.enrollmentDateId, kind: r.kind, enrollmentStatus: r.status,
        attendanceStatus: r.attendanceStatus ?? null, arrivedAt: r.arrivedAt ?? null, attendanceNote: r.attendanceNote ?? null,
        itemId: r.itemId, childName: r.childName, childGrade: r.childGrade ?? null, childSchool: r.childSchool ?? null,
        parentName: r.parentName, parentPhone: r.parentPhone,
        sessionDateId: r.sessionDateId, // 이 좌석이 속한 회차(형제 반일 수 있음)
        offeringTitle: r.rowOfferingTitle == null ? null : offeringTitleWithFrequency({ title: r.rowOfferingTitle, code: r.rowOfferingCode }), // 학생이 속한 반 이름 (코트 합산 명단에서 반 구분용)
        isThisOffering: r.isThisOffering === true, // 열려있는 회차와 같은 반인지 (선택된 반 강조용)
        selectedWeekdays, // 학생이 신청한 요일 키 목록 (예: ["MON","WED"])
        // 화면용 라벨 (예: "월·수", 날짜 선택이면 "날짜 선택 3회")
        selectedWeekdayLabel: selectedDates.length > 0 ? `날짜 선택 ${selectedDates.length}회` : weekdayLabel(selectedWeekdays),
        selectedDates, // 날짜별 선택일 때 고른 날짜(KST 'YYYY-MM-DD'), 아니면 빈 배열
        periodLabel: typeof r.periodLabel === "string" && r.periodLabel.trim() ? r.periodLabel.trim() : null, // 고른 기간 이름(없으면 null)
        originAbsence: r.absentSessionDateId ? seoulParts(r.originStartsAt).dateLabel : null,
      };
    }),
  };
}

// 4) 출결 기록/변경
export async function setSeasonalAttendance(
  enrollmentDateId: string,
  status: string | null,
  opts: { note?: string | null; arrivedAt?: string | null; userId?: string | null } = {},
) {
  if (status !== null && !VALID_ATTENDANCE.has(status)) {
    throw new Error("INVALID_ATTENDANCE_STATUS");
  }
  const arrived = status === "LATE" && opts.arrivedAt ? new Date(opts.arrivedAt) : null;
  await prisma.$executeRawUnsafe(
    `UPDATE "SpecialProgramEnrollmentDate"
        SET "attendanceStatus" = $2,
            "attendanceNote" = $3,
            "arrivedAt" = $4,
            "attendanceCheckedAt" = CASE WHEN $2 IS NULL THEN NULL ELSE now() END,
            "attendanceCheckedByUserId" = $5,
            "updatedAt" = now()
      WHERE id = $1`,
    enrollmentDateId, status, opts.note ?? null, arrived, opts.userId ?? null,
  );
  return { ok: true };
}

export { gradeToNumber } from "@/lib/seasonal/makeup";

// 5) 선생님(스태프) — 특정 날짜(기본 오늘)의 특강 회차 목록. INSTRUCTOR는 본인 담당만.
export async function getSeasonalDatesForStaff(userId: string, role: string, ymd?: string | null) {
  const targetYmd = ymd || seoulParts(new Date()).ymd;
  const scopeInstructor = role === "INSTRUCTOR";
  // 왜 Session을 LEFT JOIN 하나?
  // 특강 수업 카드를 정규 수업처럼 "수업 시작 → 통합 진행화면" 흐름으로 바꾸려면
  // 각 회차에 연결된 정규 Session의 진행 상태(PLANNED/IN_PROGRESS/COMPLETED)와 그 sessionId가 필요하다.
  // - status 로 [수업 시작]/[이어하기]/[완료] 버튼을 분기한다.
  // - sessionId 로 진행 중/완료 세션의 통합 화면(sessions/[id])으로 바로 이동한다.
  // - linkedClassId 는 startClassSession(정규 서버액션)이 요구하는 classId 이므로 함께 내려준다.
  // Session은 시작 시 sessionKey `seasonal:<sessionDateId>`로 그 회차에 1:1로 붙는다(s."specialProgramSessionDateId" = sd.id).
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT sd.id, sd."startsAt", sd."endsAt", o.title AS "offeringTitle", o.code AS "offeringCode", o.capacity, o."instructorName",
            o."linkedClassId" AS "linkedClassId",
            s.id AS "sessionId", s.status AS "sessionStatus",
            COUNT(e.id) FILTER (WHERE e.status = 'SCHEDULED') AS scheduled,
            COUNT(e.id) FILTER (WHERE e.status = 'SCHEDULED' AND e."attendanceStatus" IS NULL) AS unchecked
       FROM "SpecialProgramSessionDate" sd
       JOIN "SpecialProgramOffering" o ON o.id = sd."offeringId"
       LEFT JOIN "SpecialProgramEnrollmentDate" e ON e."sessionDateId" = sd.id AND e.status <> 'CANCELLED'
       LEFT JOIN "Session" s ON s."specialProgramSessionDateId" = sd.id
      WHERE (sd."startsAt" AT TIME ZONE 'Asia/Seoul')::date = $1::date
        AND ($2 = false OR o."instructorId" = $3)
      GROUP BY sd.id, sd."startsAt", sd."endsAt", o.title, o.code, o.capacity, o."instructorName",
               o."linkedClassId", s.id, s.status
      ORDER BY sd."startsAt" ASC`,
    targetYmd, scopeInstructor, userId,
  );
  return {
    ymd: targetYmd,
    dates: rows.map((r) => {
      const p = seoulParts(r.startsAt); const end = seoulParts(r.endsAt);
      return {
        sessionDateId: r.id, offeringTitle: offeringTitleWithFrequency({ title: r.offeringTitle, code: r.offeringCode }),
        dateLabel: p.dateLabel, dayLabel: p.dayLabel, startTime: p.timeLabel, endTime: end.timeLabel,
        capacity: r.capacity == null ? null : Number(r.capacity),
        instructorName: r.instructorName ?? null,
        scheduled: num(r.scheduled), unchecked: num(r.unchecked),
        // 정규 수업 시작 흐름 재사용에 필요한 연결 정보
        linkedClassId: r.linkedClassId ?? null,
        sessionId: r.sessionId ?? null,
        sessionStatus: (r.sessionStatus ?? null) as "PLANNED" | "IN_PROGRESS" | "COMPLETED" | null,
      };
    }),
  };
}
