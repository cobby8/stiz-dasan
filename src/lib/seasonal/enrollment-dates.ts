import { prisma } from "@/lib/prisma";
import { SEASONAL_WEEKDAYS, type SeasonalWeekday } from "@/lib/seasonal/contracts";
import { weekdayInSeoul } from "@/lib/seasonal/planning";
import { diffEnrollmentDates as diffSlots, type EnrollmentSlotSnapshot as SlotSnapshot } from "./enrollment-dates-diff";
// 2026-11-18 기간 선택·날짜별 선택 — «이 신청서가 이 회차에 나오는가»는 공용 규칙 한 곳에서 판정한다.
import { pickSessionDatesForApplication } from "@/lib/seasonal/attendance-rule";

/**
 * 방학특강 정규 수강일(kind='REGULAR') 슬롯 생성 라이브러리.
 *
 * 배경: 지금까지 승인 경로에 REGULAR 슬롯을 만드는 코드가 없어서, 날짜별 출석부에
 * 학생이 나타나지 않았다(운영자가 수동 백필로 메워 왔다). 이 파일이 그 구멍을 메운다.
 *
 * 안전 원칙 (절대 위반 금지)
 * - INSERT ... ON CONFLICT DO NOTHING 만 사용한다. DO UPDATE 를 쓰면 이미 배정된
 *   보강 슬롯(kind='MAKEUP')이 REGULAR 로 덮어써져 보강 배정이 사라진다.
 * - 기존 행을 UPDATE / DELETE 하지 않는다. "누락분 채우기"만 한다.
 * - 요일이 바뀌었을 때 기존 슬롯을 지우는 로직은 넣지 않는다(출결 기록 소실 위험).
 * - PgBouncer 트랜잭션 모드 때문에 Prisma ORM 메서드 대신 $queryRawUnsafe / $executeRawUnsafe 를 쓴다.
 */

// 예전 데이터에 한글/풀네임 요일이 섞여 있어 관대하게 정규화한다(알 수 없는 값은 조용히 무시).
const WEEKDAY_ALIASES: Record<string, SeasonalWeekday> = {
  MON: "MON", MONDAY: "MON", 월: "MON", 월요일: "MON",
  TUE: "TUE", TUESDAY: "TUE", 화: "TUE", 화요일: "TUE",
  WED: "WED", WEDNESDAY: "WED", 수: "WED", 수요일: "WED",
  THU: "THU", THURSDAY: "THU", 목: "THU", 목요일: "THU",
  FRI: "FRI", FRIDAY: "FRI", 금: "FRI", 금요일: "FRI",
  SAT: "SAT", SATURDAY: "SAT", 토: "SAT", 토요일: "SAT",
  SUN: "SUN", SUNDAY: "SUN", 일: "SUN", 일요일: "SUN",
};

export type SessionDateLike = { id: string; startsAt: Date | string };

/** 신청서에 저장된 요일 값을 MON~SUN 표준 키로 정리한다. 잘못된 값은 버린다. */
export function normalizeWeekdayKeys(values: unknown): SeasonalWeekday[] {
  if (!Array.isArray(values)) return [];
  const normalized = values
    .map((value) => WEEKDAY_ALIASES[String(value ?? "").trim().toUpperCase()])
    .filter((weekday): weekday is SeasonalWeekday => Boolean(weekday));
  // 입력 순서와 무관하게 항상 월~일 순서로 정렬해 결과를 예측 가능하게 만든다.
  return SEASONAL_WEEKDAYS.filter((weekday) => normalized.includes(weekday));
}

/**
 * 특강 전체 회차 중 학생이 실제로 나오는 날짜만 고른다.
 * - selectedWeekdays 가 비었거나 알 수 없는 값뿐이면 => 전 회차(주5회/구 데이터 대응).
 * - 요일 판정은 반드시 서울시간(Asia/Seoul) 기준. UTC로 판정하면 밤 수업이 전날 요일로 밀린다.
 */
export function pickSessionDatesForWeekdays<T extends SessionDateLike>(
  sessionDates: T[],
  selectedWeekdays: unknown,
): T[] {
  const wanted = normalizeWeekdayKeys(selectedWeekdays);
  if (wanted.length === 0) return [...sessionDates];
  return sessionDates.filter((sessionDate) => {
    const startsAt = sessionDate.startsAt instanceof Date ? sessionDate.startsAt : new Date(sessionDate.startsAt);
    if (Number.isNaN(startsAt.getTime())) return false;
    return wanted.includes(weekdayInSeoul(startsAt));
  });
}

export type SyncEnrollmentDatesResult = {
  /** 실제로 처리했는지 (APPROVED 아님/회차 없음 등이면 false) */
  applied: boolean;
  /** 이 학생이 나와야 하는 날짜 수 */
  matchedCount: number;
  /** 이번 실행에서 새로 만들어진 슬롯 수 (두 번째 실행부터는 0이어야 정상 = 멱등) */
  insertedCount: number;
  reason?: "ITEM_NOT_FOUND" | "ITEM_NOT_APPROVED" | "NO_SESSION_DATES" | "NO_MATCHED_DATES";
};

/**
 * 승인된 신청 항목에 대해 정규 수강일(kind='REGULAR') 슬롯을 채운다.
 * 여러 번 실행해도 안전하다(ON CONFLICT DO NOTHING 이라 중복도 변경도 없다).
 */
export async function syncEnrollmentDatesForItem(applicationItemId: string): Promise<SyncEnrollmentDatesResult> {
  // 1) 신청 항목 + 신청서의 선택 요일 + (전환 완료된 경우) 학생 ID 를 한 번에 읽는다.
  const itemRows = await prisma.$queryRawUnsafe<Array<{
    id: string;
    offeringId: string;
    status: string;
    selectedWeekdays: string[] | null;
    selectionMode: string | null;
    selectedDates: string[] | null;
    periodStartDate: string | null;
    periodEndDate: string | null;
    studentId: string | null;
  }>>(
    // 기간·날짜 칸도 함께 읽는다(기존 신청서는 빈 배열·NULL 이라 예전 «요일만» 결과와 같다).
    `SELECT it.id,
            it."offeringId",
            it.status,
            app."selectedWeekdays" AS "selectedWeekdays",
            app."selectionMode" AS "selectionMode",
            app."selectedDates" AS "selectedDates",
            app."periodStartDate" AS "periodStartDate",
            app."periodEndDate" AS "periodEndDate",
            en."studentId" AS "studentId"
       FROM "SpecialProgramApplicationItem" it
       JOIN "SpecialProgramApplication" app ON app.id = it."applicationId"
       LEFT JOIN "Enrollment" en ON en.id = it."enrollmentId"
      WHERE it.id = $1
      LIMIT 1`,
    applicationItemId,
  );
  const item = itemRows[0];
  if (!item) return { applied: false, matchedCount: 0, insertedCount: 0, reason: "ITEM_NOT_FOUND" };
  // 승인된 항목만 좌석을 깐다. 대기/거절/취소 항목은 출석부에 나오면 안 된다.
  if (item.status !== "APPROVED") {
    return { applied: false, matchedCount: 0, insertedCount: 0, reason: "ITEM_NOT_APPROVED" };
  }

  // 2) 이 특강(offering)의 전체 회차 날짜를 가져온다.
  const sessionDates = await prisma.$queryRawUnsafe<Array<{ id: string; startsAt: Date | string }>>(
    `SELECT sd.id, sd."startsAt"
       FROM "SpecialProgramSessionDate" sd
      WHERE sd."offeringId" = $1
      ORDER BY sd."startsAt" ASC`,
    item.offeringId,
  );
  if (sessionDates.length === 0) {
    // 특강에 회차 날짜가 하나도 없으면 좌석을 만들 수 없다. 조용히 넘어가면 "승인했는데 출석부가 비어 있다"를
    // 아무도 눈치채지 못하므로 경고 로그를 남긴다. (반환값·동작은 그대로)
    console.warn(
      "[seasonal enrollment-dates] 좌석 생성 건너뜀: 특강에 회차 날짜가 없습니다.",
      { applicationItemId, offeringId: item.offeringId, reason: "NO_SESSION_DATES" },
    );
    return { applied: false, matchedCount: 0, insertedCount: 0, reason: "NO_SESSION_DATES" };
  }

  // 3) 학생이 나오는 날짜만 고른다(서울시간 기준) — 고른 날짜 > 기간 > 요일 순서의 공용 규칙.
  const matched = pickSessionDatesForApplication(sessionDates, item);
  if (matched.length === 0) {
    // 신청 요일과 겹치는 회차가 하나도 없는 경우(예: 화·목 신청인데 특강이 월·수만 열림).
    // 운영자가 요일 설정을 확인할 수 있도록 신청 요일 값까지 함께 남긴다.
    console.warn(
      "[seasonal enrollment-dates] 좌석 생성 건너뜀: 신청 요일과 겹치는 회차가 없습니다.",
      {
        applicationItemId,
        offeringId: item.offeringId,
        selectedWeekdays: item.selectedWeekdays,
        selectedDates: item.selectedDates,
        periodStartDate: item.periodStartDate,
        periodEndDate: item.periodEndDate,
        sessionDateCount: sessionDates.length,
        reason: "NO_MATCHED_DATES",
      },
    );
    return { applied: false, matchedCount: 0, insertedCount: 0, reason: "NO_MATCHED_DATES" };
  }

  // 4) 누락된 슬롯만 채운다.
  //    - 파라미터: $1=신청항목, $2=특강, $3=학생(없으면 null), $4.. = 회차 날짜 ID들
  //    - ON CONFLICT DO NOTHING: 이미 있는 행(REGULAR/MAKEUP 무관)은 절대 건드리지 않는다.
  const params: Array<string | null> = [item.id, item.offeringId, item.studentId ?? null, ...matched.map((row) => row.id)];
  const valuesSql = matched.map((_, index) => `($1,$2,$${index + 4},$3,'REGULAR','SCHEDULED')`).join(",");
  const insertedCount = await prisma.$executeRawUnsafe(
    `INSERT INTO "SpecialProgramEnrollmentDate"
       ("applicationItemId","offeringId","sessionDateId","studentId","kind","status")
     VALUES ${valuesSql}
     ON CONFLICT ("applicationItemId","sessionDateId") DO NOTHING`,
    ...params,
  );

  return { applied: true, matchedCount: matched.length, insertedCount: Number(insertedCount) || 0 };
}

/**
 * 승인 처리 흐름에서 쓰는 안전 래퍼.
 * 슬롯 생성이 실패해도 승인 자체는 성공으로 유지해야 하므로 예외를 삼키고 로그만 남긴다.
 */
export async function syncEnrollmentDatesForItemSafe(applicationItemId: string): Promise<SyncEnrollmentDatesResult | null> {
  try {
    return await syncEnrollmentDatesForItem(applicationItemId);
  } catch (error) {
    console.error("[seasonal enrollment-dates sync]", applicationItemId, error);
    return null;
  }
}

/**
 * 신청 항목이 취소·반려 등 'APPROVED 아님'으로 바뀌면 그 항목의 좌석(SCHEDULED)을 소프트 취소한다.
 * → 취소자가 선생님 출석부·학생 수(좌석 기준)에서 사라진다. resync는 APPROVED 항목만 다루므로 취소는 여기서 처리한다.
 * 절대 규칙: 출결이 이미 찍힌 좌석(attendanceStatus IS NOT NULL)은 기록 보존을 위해 건드리지 않는다.
 */
export async function cancelEnrollmentDatesForItem(applicationItemId: string): Promise<number> {
  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "SpecialProgramEnrollmentDate"
        SET status='CANCELLED', "updatedAt"=now()
      WHERE "applicationItemId" = $1
        AND kind = 'REGULAR'
        AND status <> 'CANCELLED'
        AND "attendanceStatus" IS NULL`,
    applicationItemId,
  );
  return Number(affected) || 0;
}
export async function cancelEnrollmentDatesForItemSafe(applicationItemId: string): Promise<number> {
  try {
    return await cancelEnrollmentDatesForItem(applicationItemId);
  } catch (error) {
    console.error("[seasonal enrollment-dates cancel]", applicationItemId, error);
    return 0;
  }
}

/* ------------------------------------------------------------------------- *
 * 반 이동·요일 변경 재동기화 (resync)
 *
 * 왜 필요한가: 승인 후 관리자가 반을 바꾸거나 요일을 바꾸면 옛 반/옛 요일 좌석이 그대로 남고
 * 새 반/새 요일 좌석은 생기지 않아, 출석부에 "예전 반에 유령 학생 + 새 반에 없는 학생"이 생긴다.
 *
 * 절대 규칙: 출결이 찍힌 행(attendanceStatus IS NOT NULL)은 건드리지 않는다.
 * 삭제·취소·kind 변경 모두 금지이며, SQL의 WHERE 조건으로 물리적으로 불가능하게 만든다.
 * 이탈한 좌석은 하드 DELETE 가 아니라 status='CANCELLED' 소프트 취소만 한다.
 * ------------------------------------------------------------------------- */

// 순수 계산 부분은 DB 의존이 전혀 없는 별도 모듈에 두고 여기서 다시 내보낸다(단위 테스트 용이).
export { diffEnrollmentDates } from "./enrollment-dates-diff";
export type { EnrollmentSlotSnapshot, EnrollmentDatesDiff } from "./enrollment-dates-diff";

export type ResyncEnrollmentDatesResult = {
  applied: boolean;
  /** 재동기화한 승인 항목 수 */
  itemCount: number;
  inserted: number;
  cancelled: number;
  revived: number;
  /** 출결이 있어 거두지 못한 좌석 수 (0이 아니면 감사로그에 남긴다) */
  blockedByAttendance: number;
  reason?: "NO_APPROVED_ITEMS";
};

/** IN 절 플레이스홀더 ($n,$n+1,...) 생성기. */
function placeholders(count: number, startIndex: number) {
  return Array.from({ length: count }, (_, index) => `$${startIndex + index}`).join(",");
}

/**
 * 신청서(Application) 단위로 정규 수강일 좌석을 다시 맞춘다. 여러 번 실행해도 결과가 같다(멱등).
 *
 * ⚠️ 항목(Item) 단위가 아니라 신청서 단위인 이유: `selectedWeekdays` 는 항목이 아니라 신청서에 저장된다.
 * 한 신청서에 반이 2개면 한쪽 항목만 고쳐도 형제 항목의 좌석까지 낡아버린다.
 */
export async function resyncEnrollmentDatesForApplication(applicationId: string): Promise<ResyncEnrollmentDatesResult> {
  const empty = { applied: false, itemCount: 0, inserted: 0, cancelled: 0, revived: 0, blockedByAttendance: 0 };

  // 1) 이 신청서의 승인 항목 + 신청서 선택 요일 + (전환된 경우) 학생 ID
  const items = await prisma.$queryRawUnsafe<Array<{
    id: string; offeringId: string; selectedWeekdays: string[] | null; studentId: string | null;
    selectionMode: string | null; selectedDates: string[] | null;
    periodStartDate: string | null; periodEndDate: string | null;
  }>>(
    // 기간·날짜 칸도 함께 읽는다(기존 신청서는 빈 배열·NULL → 예전 결과 그대로).
    `SELECT it.id,
            it."offeringId",
            app."selectedWeekdays" AS "selectedWeekdays",
            app."selectionMode" AS "selectionMode",
            app."selectedDates" AS "selectedDates",
            app."periodStartDate" AS "periodStartDate",
            app."periodEndDate" AS "periodEndDate",
            en."studentId" AS "studentId"
       FROM "SpecialProgramApplicationItem" it
       JOIN "SpecialProgramApplication" app ON app.id = it."applicationId"
       LEFT JOIN "Enrollment" en ON en.id = it."enrollmentId"
      WHERE it."applicationId" = $1
        AND it.status = 'APPROVED'`,
    applicationId,
  );
  if (items.length === 0) return { ...empty, reason: "NO_APPROVED_ITEMS" };

  // 2) 관련 특강의 회차 날짜를 한 번에 읽는다.
  const offeringIds = Array.from(new Set(items.map((item) => item.offeringId)));
  const sessionRows = await prisma.$queryRawUnsafe<Array<{ id: string; offeringId: string; startsAt: Date | string }>>(
    `SELECT sd.id, sd."offeringId", sd."startsAt"
       FROM "SpecialProgramSessionDate" sd
      WHERE sd."offeringId" IN (${placeholders(offeringIds.length, 1)})
      ORDER BY sd."startsAt" ASC`,
    ...offeringIds,
  );
  const sessionsByOffering = new Map<string, Array<{ id: string; startsAt: Date | string }>>();
  for (const row of sessionRows) {
    const list = sessionsByOffering.get(row.offeringId) ?? [];
    list.push({ id: row.id, startsAt: row.startsAt });
    sessionsByOffering.set(row.offeringId, list);
  }

  // 3) 현재 좌석 스냅샷을 한 번에 읽는다.
  const itemIds = items.map((item) => item.id);
  const slotRows = await prisma.$queryRawUnsafe<Array<{
    applicationItemId: string; sessionDateId: string; kind: string; status: string; attendanceStatus: string | null;
  }>>(
    `SELECT e."applicationItemId" AS "applicationItemId", e."sessionDateId" AS "sessionDateId",
            e.kind, e.status, e."attendanceStatus" AS "attendanceStatus"
       FROM "SpecialProgramEnrollmentDate" e
      WHERE e."applicationItemId" IN (${placeholders(itemIds.length, 1)})`,
    ...itemIds,
  );
  const slotsByItem = new Map<string, SlotSnapshot[]>();
  for (const row of slotRows) {
    const list = slotsByItem.get(row.applicationItemId) ?? [];
    list.push({ sessionDateId: row.sessionDateId, kind: row.kind, status: row.status, attendanceStatus: row.attendanceStatus });
    slotsByItem.set(row.applicationItemId, list);
  }

  let inserted = 0;
  let cancelled = 0;
  let revived = 0;
  let blockedByAttendance = 0;

  for (const item of items) {
    const sessions = sessionsByOffering.get(item.offeringId) ?? [];
    // 공용 규칙(고른 날짜 > 기간 > 요일)으로 목표 회차를 구한다.
    const matched = pickSessionDatesForApplication(sessions, item);
    if (matched.length === 0) {
      // 목표 날짜를 하나도 못 구한 경우(회차 미등록, 요일 설정 오류 등)에는 아무것도 거두지 않는다.
      // 여기서 diff 를 그대로 적용하면 기존 좌석이 통째로 취소돼 출석부가 비어버린다.
      console.warn(
        "[seasonal enrollment-dates resync] 목표 회차를 찾지 못해 재동기화를 건너뜁니다.",
        {
          applicationId, applicationItemId: item.id, offeringId: item.offeringId,
          selectedWeekdays: item.selectedWeekdays, sessionDateCount: sessions.length,
        },
      );
      continue;
    }
    const diff = diffSlots(slotsByItem.get(item.id) ?? [], matched.map((session) => session.id));
    blockedByAttendance += diff.blockedByAttendance.length;

    // 3-1) 채우기 — 이미 있는 행(보강 포함)은 절대 덮지 않는다.
    if (diff.toInsert.length > 0) {
      const params: Array<string | null> = [item.id, item.offeringId, item.studentId ?? null, ...diff.toInsert];
      const valuesSql = diff.toInsert.map((_, index) => `($1,$2,$${index + 4},$3,'REGULAR','SCHEDULED')`).join(",");
      const affected = await prisma.$executeRawUnsafe(
        `INSERT INTO "SpecialProgramEnrollmentDate"
           ("applicationItemId","offeringId","sessionDateId","studentId","kind","status")
         VALUES ${valuesSql}
         ON CONFLICT ("applicationItemId","sessionDateId") DO NOTHING`,
        ...params,
      );
      inserted += Number(affected) || 0;
    }

    // 3-2) 거두기 — 소프트 취소만. 출결이 있으면 WHERE 에서 아예 제외된다.
    if (diff.toCancel.length > 0) {
      const affected = await prisma.$executeRawUnsafe(
        `UPDATE "SpecialProgramEnrollmentDate"
            SET status='CANCELLED', "updatedAt"=now()
          WHERE "applicationItemId" = $1
            AND kind = 'REGULAR'
            AND status <> 'CANCELLED'
            AND "attendanceStatus" IS NULL
            AND "sessionDateId" IN (${placeholders(diff.toCancel.length, 2)})`,
        item.id, ...diff.toCancel,
      );
      cancelled += Number(affected) || 0;
    }

    // 3-3) 되살리기 — 예전에 거둔 좌석으로 다시 돌아온 경우.
    if (diff.toRevive.length > 0) {
      const affected = await prisma.$executeRawUnsafe(
        `UPDATE "SpecialProgramEnrollmentDate"
            SET status='SCHEDULED', "updatedAt"=now()
          WHERE "applicationItemId" = $1
            AND kind = 'REGULAR'
            AND status = 'CANCELLED'
            AND "attendanceStatus" IS NULL
            AND "sessionDateId" IN (${placeholders(diff.toRevive.length, 2)})`,
        item.id, ...diff.toRevive,
      );
      revived += Number(affected) || 0;
    }
  }

  if (blockedByAttendance > 0) {
    // 사용자 결정: 출결이 찍힌 학생의 반 이동은 허용한다. 다만 찍힌 날은 예전 반에 남으므로 흔적을 남긴다.
    console.warn(
      "[seasonal enrollment-dates resync] 출결이 기록된 좌석은 그대로 두었습니다.",
      { applicationId, blockedByAttendance },
    );
  }

  return { applied: true, itemCount: items.length, inserted, cancelled, revived, blockedByAttendance };
}

/**
 * 반 이동 흐름에서 쓰는 안전 래퍼.
 * 재동기화 실패가 반 이동 자체를 되돌리면 안 되므로 예외를 삼키고 로그만 남긴다.
 */
export async function resyncEnrollmentDatesForApplicationSafe(applicationId: string): Promise<ResyncEnrollmentDatesResult | null> {
  try {
    return await resyncEnrollmentDatesForApplication(applicationId);
  } catch (error) {
    console.error("[seasonal enrollment-dates resync]", applicationId, error);
    return null;
  }
}
