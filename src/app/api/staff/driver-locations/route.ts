import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-guard";
import { staffShuttleAccess } from "@/lib/shuttle/teacherShuttleView";
import type { DriverLocationRow } from "@/app/api/admin/driver-locations/route";

export const dynamic = "force-dynamic";

/**
 * 선생님 화면 «셔틀» 탭의 «차량 현재 위치»(2026-11-16 원장 지시 «일반 선생님에게 셔틀 탭 열어줘»).
 * 관리자용(/api/admin/driver-locations)과 같은 내용이되, **기사님 운행 링크 값(token)은 내려보내지 않는다** —
 * 그 값을 알면 운행 화면을 열 수 있으므로, 줄을 구분하는 용도로만 쓰는 해시(md5)로 바꿔 보낸다.
 * 셔틀 탭에 들어올 수 있는 직원(관리자·기사님·선생님)만 읽는다.
 */
export async function GET() {
  const staff = await requireStaff().catch(() => null);
  if (!staff) return NextResponse.json({ error: "직원 로그인이 필요합니다." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (!staffShuttleAccess(staff.roles).canOpen) {
    return NextResponse.json({ error: "차량 위치를 볼 수 있는 권한이 없습니다." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const rows = await prisma.$queryRawUnsafe<DriverLocationRow[]>(
      `SELECT
         md5(token) AS token, label, latitude, longitude,
         accuracy, speed, heading, sharing,
         "updatedAt"::text AS "updatedAt",
         EXTRACT(EPOCH FROM (now() - "updatedAt"))::int AS "secondsAgo"
       FROM "DriverLocation"
       WHERE "updatedAt" > now() - INTERVAL '10 minutes'
       ORDER BY "updatedAt" DESC`,
    );
    return NextResponse.json({ locations: rows }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "차량 위치를 불러오지 못했습니다." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
