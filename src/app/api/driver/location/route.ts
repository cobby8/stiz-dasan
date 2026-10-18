import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// 기사님 GPS 위치 수신 — 인증 없이 토큰만으로 접근(토큰 자체가 열쇠).
// 10초마다 기사님 화면에서 POST. token당 1행 upsert로 현재 위치만 유지.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as {
      token?: string; lat?: number; lng?: number;
      accuracy?: number; speed?: number; heading?: number;
      label?: string; sharing?: boolean;
    } | null;

    const { token, lat, lng, accuracy, speed, heading, label, sharing = true } = body ?? {};

    if (!token || typeof lat !== "number" || typeof lng !== "number") {
      return NextResponse.json({ error: "token, lat, lng 필수" }, { status: 400 });
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return NextResponse.json({ error: "좌표 범위 오류" }, { status: 400 });
    }

    // 유효한 토큰인지 확인 (ShuttleRunLink에 없으면 403)
    const links = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "ShuttleRunLink" WHERE token = $1 LIMIT 1`,
      token,
    );
    if (!links.length) {
      return NextResponse.json({ error: "유효하지 않은 토큰" }, { status: 403 });
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO "DriverLocation" (token, label, latitude, longitude, accuracy, speed, heading, sharing, "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (token) DO UPDATE SET
         label     = COALESCE($2, "DriverLocation".label),
         latitude  = $3,
         longitude = $4,
         accuracy  = $5,
         speed     = $6,
         heading   = $7,
         sharing   = $8,
         "updatedAt" = now()`,
      token,
      typeof label === "string" && label.trim() ? label.trim().slice(0, 100) : null,
      lat, lng,
      accuracy != null && Number.isFinite(accuracy) ? accuracy : null,
      speed    != null && Number.isFinite(speed)    ? speed    : null,
      heading  != null && Number.isFinite(heading)  ? heading  : null,
      sharing === false ? false : true,
    );

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "저장 실패" }, { status: 500 });
  }
}
