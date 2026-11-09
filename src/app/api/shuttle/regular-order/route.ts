import { NextResponse } from "next/server";
import { isAnyDriverRunToken } from "@/lib/shuttle/driverToken";
import { prisma } from "@/lib/prisma";
import { kstDow } from "@/lib/datetime/kst";
import { DriverOrderError, parseDriverOrderUpdates, planDriverOrder } from "@/lib/shuttle/driverOrderPlan";
import type { RegularShuttleStop } from "@/lib/shuttle/regularSheet";

export const dynamic = "force-dynamic";

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00+09:00`);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date) === value ? value : null;
}

// 기사님 화면 «순서·도착 시각 편집» 저장 — 셔틀 명단(RegularShuttleStop)만 고친다.
// 6단계(2026-11-09): 기사님 화면은 명단만 읽으므로 저장 노선(RegularDispatchRoute)은 읽지도 쓰지도 않는다.
// ⚠️ PgBouncer 트랜잭션 모드 → Prisma ORM 기본 메서드(updateMany·findMany) 대신 $queryRawUnsafe/$executeRawUnsafe 만 쓴다.
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
    const updated = await prisma.$transaction(async tx => {
      // 항상 같은 순서로 잠가 두 저장 요청이 중간 상태를 서로 덮어쓰지 않게 한다.
      const rows = await tx.$queryRawUnsafe<RegularShuttleStop[]>(
        `SELECT * FROM "RegularShuttleStop" WHERE "serviceMonth"=$1 AND "weekday"=$2
          AND "direction" IN ('BOARD','ALIGHT') AND "studentName" IS NOT NULL AND btrim("studentName") <> ''
          ORDER BY "sortOrder", "stopName", "id" FOR UPDATE`, serviceMonth, weekday,
      );
      // 기사님 화면과 같은 조립기(명단 순서 그대로)로 «연 화면 = 지금 DB» 인지·저장 뒤 순서가 맞는지 검사한다.
      // 저장 노선이 없으므로 routes·학생↔행 연결은 빈 값이다(조립기가 명단 폴백으로만 묶는다).
      planDriverOrder({ rows, routes: [], updates, baseline, rowIdsByStudentId: { PICKUP: new Map(), DROPOFF: new Map() } });
      let count = 0;
      for (const update of updates) {
        // 행 id·달·요일·방향을 모두 조건에 걸어 다른 달·요일 행을 실수로 고치지 않는다.
        const changed = Number(await tx.$executeRawUnsafe(
          `UPDATE "RegularShuttleStop" SET "sortOrder"=$1, "arriveTime"=$2
            WHERE "id" = ANY($3::text[]) AND "serviceMonth"=$4 AND "weekday"=$5 AND "direction" IN ('BOARD','ALIGHT')`,
          update.sortOrder, update.arriveTime, update.rowIds, serviceMonth, weekday,
        )) || 0;
        if (changed !== update.rowIds.length) throw new DriverOrderError("정차 명단이 변경되어 저장을 취소했습니다. 새로고침해 주세요.");
        count += changed;
      }
      // 저장 성공 응답 전에 다시 읽어 실제 반영값을 확인한다. 실패하면 위 변경도 함께 취소된다.
      const readback = await tx.$queryRawUnsafe<{ id: string; sortOrder: number; arriveTime: string | null }[]>(
        `SELECT "id","sortOrder","arriveTime" FROM "RegularShuttleStop" WHERE "id" = ANY($1::text[]) AND "serviceMonth"=$2 AND "weekday"=$3`,
        updates.flatMap(update => update.rowIds), serviceMonth, weekday,
      );
      const byId = new Map(readback.map(row => [String(row.id), row]));
      for (const update of updates) for (const id of update.rowIds) {
        const row = byId.get(id);
        if (!row || Number(row.sortOrder) !== update.sortOrder || (row.arriveTime ?? null) !== update.arriveTime) throw new DriverOrderError("저장 결과를 확인하지 못했습니다. 다시 확인해 주세요.");
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
