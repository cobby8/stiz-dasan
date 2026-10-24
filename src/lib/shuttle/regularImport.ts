import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import type { RegularShuttleStop } from "./regularSheet";

// 셔틀 명단(RegularShuttleStop) 조회·좌표·정차 순서 저장. PgBouncer 때문에 $queryRawUnsafe/$executeRawUnsafe 고정.
// 2026-10-02 구글 시트에서 명단을 가져오던 함수는 종료·삭제했다(API 는 410). 명단 편집은 regularRosterEdit.ts 가 맡는다.

export function normalizeServiceMonth(value: string | null | undefined): string {
  const month = String(value ?? "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("적용 월은 YYYY-MM 형식이어야 합니다.");
  return month;
}

/** 저장된 월 목록. 최신 월부터 표시한다. */
export async function getRegularShuttleMonths(): Promise<string[]> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ serviceMonth: string }[]>(
      `SELECT DISTINCT "serviceMonth" FROM "RegularShuttleStop" ORDER BY "serviceMonth" DESC`,
    );
    return rows.map((row) => String(row.serviceMonth)).filter((month) => /^\d{4}-\d{2}$/.test(month));
  } catch { return []; }
}

/** 좌표(latitude)가 아직 없는 '고유 정류장 이름' 목록을 돌려준다(빈 이름 제외). 1회용 좌표 채우기 화면용. */
export async function getRegularStopsWithoutCoords(serviceMonth?: string): Promise<string[]> {
  try {
    // latitude 가 null 인 행들의 정류장 이름을 중복 없이(대소문자·공백 유지) 조회.
    const rows = await prisma.$queryRawUnsafe<{ stopName: string }[]>(
      `SELECT DISTINCT "stopName"
         FROM "RegularShuttleStop"
        WHERE "latitude" IS NULL AND COALESCE(TRIM("stopName"), '') <> ''
          AND ($1::text IS NULL OR "serviceMonth"=$1)
        ORDER BY "stopName" ASC`,
      serviceMonth ?? null,
    );
    return rows.map((r) => String(r.stopName ?? "").trim()).filter(Boolean);
  } catch {
    // 테이블이 없거나 조회 실패 시 빈 목록(화면은 "채울 정류장 없음"으로 안전 처리).
    return [];
  }
}

/** 정류장 이름별 좌표를 저장한다. 같은 이름의 모든 행에 동일 좌표를 채운다(원장 전용). */
export async function saveRegularStopCoords(
  entries: { stopName: string; latitude: number; longitude: number }[],
): Promise<{ updated: number }> {
  await requireAdmin();
  let updated = 0;
  for (const e of entries) {
    const name = (e.stopName ?? "").trim();
    if (!name || !Number.isFinite(e.latitude) || !Number.isFinite(e.longitude)) continue;
    const n = await prisma.$executeRawUnsafe(
      `UPDATE "RegularShuttleStop" SET "latitude"=$1,"longitude"=$2 WHERE "stopName"=$3`,
      e.latitude, e.longitude, name,
    );
    updated += Number(n) || 0;
  }
  return { updated };
}

/** 정규 셔틀 정차의 순서(sortOrder)·도착시각(arriveTime)을 저장한다(원장 전용). id 기준 개별 갱신. */
export async function saveRegularStopOrder(
  updates: { id: string; sortOrder: number; arriveTime: string | null }[],
  serviceMonth: string,
): Promise<{ updated: number }> {
  await requireAdmin();
  const month = normalizeServiceMonth(serviceMonth);
  const updated = await prisma.$transaction(async (tx) => {
    let count = 0;
    for (const u of updates) {
      const id = (u.id ?? "").trim();
      if (!id || !Number.isFinite(u.sortOrder)) continue;
      const arrive = typeof u.arriveTime === "string" && /^\d{1,2}:\d{2}$/.test(u.arriveTime.trim()) ? u.arriveTime.trim() : null;
      const n = await tx.$executeRawUnsafe(
        `UPDATE "RegularShuttleStop" SET "sortOrder"=$1,"arriveTime"=$2 WHERE "id"=$3 AND "serviceMonth"=$4`,
        Math.round(u.sortOrder), arrive, id, month,
      );
      count += Number(n) || 0;
    }
    if (count !== updates.length) throw new Error("일부 정차가 선택한 월에 없어 저장을 취소했습니다. 차량표를 새로고침해 주세요.");
    return count;
  });
  return { updated };
}

/** 저장된 정규 셔틀 정차를 요일 순·시간 순으로 돌려준다. */
export async function getRegularShuttleStops(serviceMonth?: string): Promise<{ stops: RegularShuttleStop[]; importedAt: string | null; serviceMonth: string | null; months: string[] }> {
  try {
    const months = await getRegularShuttleMonths();
    const month = serviceMonth ? normalizeServiceMonth(serviceMonth) : (months[0] ?? null);
    if (!month) return { stops: [], importedAt: null, serviceMonth: null, months };
    // sortOrder 가 겹친 행은 id(바이트 순)로 순서를 고정한다 — 관리자 화면·기사님 화면·학생 추가 삽입 계산
    // (regularRosterEditLogic rowOrder)이 같은 순서를 보게 하려는 것. 예전엔 겹친 행 순서가 DB 마음대로였다.
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT "id","serviceMonth","weekday","classTime","arriveTime","stopName","direction","studentName","studentId","studentPhone","parentPhone","note","sortOrder","latitude","longitude","importedAt"
         FROM "RegularShuttleStop" WHERE "serviceMonth"=$1 ORDER BY "weekday" ASC, "sortOrder" ASC, "id" COLLATE "C" ASC`,
      month,
    );
    const WD = ["일", "월", "화", "수", "목", "금", "토"];
    const stops: RegularShuttleStop[] = rows.map((r) => ({
      id: r.id != null ? String(r.id) : undefined,
      serviceMonth: String(r.serviceMonth ?? month),
      weekday: Number(r.weekday),
      weekdayLabel: WD[Number(r.weekday)] ?? "",
      classTime: (r.classTime as string | null) ?? null,
      arriveTime: (r.arriveTime as string | null) ?? null,
      stopName: String(r.stopName ?? ""),
      direction: (["BOARD", "ALIGHT", "PIVOT", "RETURN"].includes(String(r.direction)) ? r.direction : "BOARD") as RegularShuttleStop["direction"],
      studentName: (r.studentName as string | null) ?? null,
      studentId: (r.studentId as string | null) ?? null,
      studentPhone: (r.studentPhone as string | null) ?? null,
      parentPhone: (r.parentPhone as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      sortOrder: Number(r.sortOrder) || 0,
      latitude: r.latitude != null ? Number(r.latitude) : null,
      longitude: r.longitude != null ? Number(r.longitude) : null,
    }));
    const importedAt = rows[0]?.importedAt ? new Date(String(rows[0].importedAt)).toISOString() : null;
    return { stops, importedAt, serviceMonth: month, months };
  } catch {
    return { stops: [], importedAt: null, serviceMonth: null, months: [] };
  }
}
