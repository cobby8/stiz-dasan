import { NextResponse } from "next/server";
import { isAnyDriverRunToken } from "@/lib/shuttle/driverToken";
import { prisma } from "@/lib/prisma";
import { kstDow } from "@/lib/datetime/kst";
import { DOW_NAMES } from "@/lib/regular/shuttleRosterLogic";
import { getRegularShuttleRiders } from "@/lib/regular/shuttleRoster";
import { DriverOrderError, parseDriverOrderUpdates, planDriverOrder, type DriverOrderRoute } from "@/lib/shuttle/driverOrderPlan";
import type { RegularShuttleStop } from "@/lib/shuttle/regularSheet";

export const dynamic = "force-dynamic";

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00+09:00`);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date) === value ? value : null;
}

// 명단과 확정 노선을 같은 봉투에 넣듯 함께 저장하여 한쪽만 성공하는 상태를 막는다.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as { token?: unknown; date?: unknown; updates?: unknown; baseline?: unknown } | null;
    const token = typeof body?.token === "string" ? body.token : "";
    const date = validDate(body?.date);
    if (!token || !date) throw new DriverOrderError("요청 형식이 올바르지 않습니다.", 400);
    if (!(await isAnyDriverRunToken(token))) return NextResponse.json({ error: "유효하지 않은 링크입니다." }, { status: 403 });
    const updates = parseDriverOrderUpdates(body?.updates);
    if (!Array.isArray(body?.baseline)) throw new DriverOrderError("화면을 새로고침한 뒤 다시 저장해 주세요.");
    const baseline = parseDriverOrderUpdates(body.baseline);
    const serviceMonth = date.slice(0, 7);
    const weekday = kstDow(date);
    const dayOfWeek = DOW_NAMES[weekday];
    const updated = await prisma.$transaction(async tx => {
      // 항상 같은 순서로 잠가 두 저장 요청이 중간 상태를 서로 덮어쓰지 않게 한다.
      const rows = await tx.$queryRawUnsafe<RegularShuttleStop[]>(
        `SELECT * FROM "RegularShuttleStop" WHERE "serviceMonth"=$1 AND "weekday"=$2
          AND "direction" IN ('BOARD','ALIGHT') AND "studentName" IS NOT NULL AND btrim("studentName") <> ''
          ORDER BY "sortOrder", "stopName", "id" FOR UPDATE`, serviceMonth, weekday,
      );
      // 확정 노선 테이블이 없는 이전 환경은 명단 경로를 유지한다. SQL 오류를 삼켜 트랜잭션을 망가뜨리지 않는다.
      const table = await tx.$queryRawUnsafe<{ present: boolean }[]>(`SELECT to_regclass('"RegularDispatchRoute"') IS NOT NULL AS "present"`);
      const hasDispatchTable = table[0]?.present === true;
      const routes = hasDispatchTable ? await tx.$queryRawUnsafe<DriverOrderRoute[]>(
        `SELECT "id","direction","payload" FROM "RegularDispatchRoute"
          WHERE "serviceMonth"=$1 AND "dayOfWeek"=$2 ORDER BY "direction" FOR UPDATE`, serviceMonth, dayOfWeek,
      ) : [];
      const maps = { PICKUP: new Map<string, string[]>(), DROPOFF: new Map<string, string[]>() };
      const order = new Map(rows.map((row, index) => [row.id, index]));
      for (const direction of ["PICKUP", "DROPOFF"] as const) {
        if (!routes.some(route => route.direction === direction)) continue;
        const roster = await getRegularShuttleRiders({ direction, serviceMonth, dayOfWeek }, tx);
        for (const rider of [...roster.riders, ...roster.unassigned]) {
          if (!rider.stopRowId || !order.has(rider.stopRowId)) throw new DriverOrderError("학생 연결이 변경되었습니다. 새로고침 후 다시 저장해 주세요.");
          const ids = maps[direction].get(rider.studentId) ?? [];
          ids.push(rider.stopRowId); maps[direction].set(rider.studentId, ids);
        }
        for (const ids of maps[direction].values()) ids.sort((a, b) => order.get(a)! - order.get(b)!);
      }
      const plan = planDriverOrder({ rows, routes, updates, baseline, rowIdsByStudentId: maps });
      let count = 0;
      for (const update of updates) {
        const result = await tx.regularShuttleStop.updateMany({
          where: { id: { in: update.rowIds }, serviceMonth, weekday, direction: { in: ["BOARD", "ALIGHT"] } },
          data: { sortOrder: update.sortOrder, arriveTime: update.arriveTime },
        });
        if (result.count !== update.rowIds.length) throw new DriverOrderError("정차 명단이 변경되어 저장을 취소했습니다. 새로고침해 주세요.");
        count += result.count;
      }
      for (const route of plan.routes) {
        const result = await tx.$executeRawUnsafe(
          `UPDATE "RegularDispatchRoute" SET "payload"=$1::jsonb,"updatedAt"=now()
            WHERE "id"=$2 AND "serviceMonth"=$3 AND "dayOfWeek"=$4 AND "direction"=$5`,
          JSON.stringify(route.payload), route.id, serviceMonth, dayOfWeek, route.direction,
        );
        if (result !== 1) throw new DriverOrderError("확정 노선이 변경되어 저장을 취소했습니다. 새로고침해 주세요.");
      }
      // 저장 성공 응답 전에 다시 읽어 실제 반영값을 확인한다. 실패하면 위 변경도 함께 취소된다.
      const readback = await tx.regularShuttleStop.findMany({ where: { id: { in: updates.flatMap(update => update.rowIds) }, serviceMonth, weekday }, select: { id: true, sortOrder: true, arriveTime: true } });
      const byId = new Map(readback.map(row => [row.id, row]));
      for (const update of updates) for (const id of update.rowIds) {
        const row = byId.get(id);
        if (!row || row.sortOrder !== update.sortOrder || row.arriveTime !== update.arriveTime) throw new DriverOrderError("저장 결과를 확인하지 못했습니다. 다시 확인해 주세요.");
      }
      const saved = hasDispatchTable ? await tx.$queryRawUnsafe<DriverOrderRoute[]>(
        `SELECT "id","direction","payload" FROM "RegularDispatchRoute" WHERE "serviceMonth"=$1 AND "dayOfWeek"=$2 ORDER BY "direction"`, serviceMonth, dayOfWeek,
      ) : [];
      // JSON의 키 순서는 DB가 바꿀 수 있으므로 JSON 문자열 대신 실제 필드 값을 비교한다.
      for (const route of plan.routes) {
        const actual = saved.find(item => item.id === route.id);
        if (!actual || !sameJson(actual.payload, route.payload)) throw new DriverOrderError("확정 노선 저장 결과를 확인하지 못했습니다.");
      }
      return count;
    }, { isolationLevel: "Serializable", timeout: 15000 });
    return NextResponse.json({ ok: true, verified: true, updated });
  } catch (error) {
    if (error instanceof DriverOrderError) return NextResponse.json({ error: error.message }, { status: error.status });
    // DB 오류 원문에는 식별 정보가 포함될 수 있어 응답과 로그 모두에 노출하지 않는다.
    return NextResponse.json({ error: "저장 중 명단이 변경되었거나 연결을 확인하지 못했습니다. 새로고침 후 다시 시도해 주세요." }, { status: 409 });
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => sameJson(item, right[index]));
  if (left != null && right != null && typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
    return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
  }
  return false;
}
