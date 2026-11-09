import "server-only";
import { prisma } from "@/lib/prisma";
import { isServiceMonth, koreaServiceMonth } from "@/lib/regular/serviceMonth";
import { buildRosterEtas, dowToRosterWeekday, type ConfirmedRosterEta, type RosterEtaRow } from "./regularRosterEtaLogic";

/**
 * 정규 셔틀 «확정 승/하차 시각» — 셔틀 명단(RegularShuttleStop) 기준(6단계, 2026-11-09).
 * 예전에는 저장 노선(RegularDispatchRoute)을 읽어 명단을 고쳐도 학부모에게 옛 시각이 보였다.
 *
 * 달 고르기: 그 달 «이하»의 가장 최근 명단 달(기사님 화면 pickServiceMonthFor 와 같은 기준)을 SQL 에서 고른다.
 * 권한: 조회 함수는 인증하지 않는다(게이트웨이 원칙). 호출부(parent.ts)가 본인 자녀 studentId 만 넘긴다(IDOR 안전).
 * ⚠️ PgBouncer 트랜잭션 모드 → $queryRawUnsafe 만 쓴다. 조회 실패는 «시각 없음»(학부모 화면은 종전과 동일).
 */
export async function getConfirmedRegularRosterEtas(
  pairs: { studentId: string; dayOfWeek: string }[],
  serviceMonth: string = koreaServiceMonth(),
): Promise<Map<string, ConfirmedRosterEta>> {
  if (!isServiceMonth(serviceMonth)) return new Map();
  const clean = (pairs ?? []).filter((p) => typeof p.studentId === "string" && p.studentId !== "" && dowToRosterWeekday(p.dayOfWeek) >= 0);
  // 빈 결과라도 모든 쌍을 null 로 채워 돌려준다(조회 실패와 같은 모양).
  const empty = buildRosterEtas(clean, [], serviceMonth);
  if (clean.length === 0) return empty;
  try {
    const rows = await prisma.$queryRawUnsafe<RosterEtaRow[]>(
      `SELECT "studentId","weekday","direction","arriveTime","sortOrder"
         FROM "RegularShuttleStop"
        WHERE "serviceMonth" = (SELECT max("serviceMonth") FROM "RegularShuttleStop" WHERE "serviceMonth" <= $1)
          AND "studentId" = ANY($2::text[])
          AND "weekday" = ANY($3::int[])
          AND "direction" IN ('BOARD','ALIGHT')
        ORDER BY "sortOrder" ASC, "id" COLLATE "C" ASC`,
      serviceMonth,
      [...new Set(clean.map((p) => p.studentId))],
      [...new Set(clean.map((p) => dowToRosterWeekday(p.dayOfWeek)))],
    );
    return buildRosterEtas(clean, rows.map((r) => ({ ...r, weekday: Number(r.weekday) })), serviceMonth);
  } catch {
    return empty;
  }
}
