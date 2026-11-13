import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
// 운행 링크 스위치(원장이 끄면 토큰만으로는 못 연다 — 셔틀 권한 있는 로그인 사용자만 통과)
import { driverLinkBlocked, driverLinkDisabledResponse } from "@/lib/shuttle/driverLinkAccess";

export const dynamic = "force-dynamic";

// 기사님 변경 요청 접수 — 인증 없이 토큰으로만 접근(토큰 자체가 열쇠).
// type: REMOVE(학생 제외) | LOCATION(주소 변경) | ORDER(순서 고정) | OTHER(기타)
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as {
      token?: string; serviceDate?: string;
      type?: string; targetId?: string; targetName?: string;
      note?: string; payload?: unknown;
    } | null;

    const { token, serviceDate, type, targetId, targetName, note, payload } = body ?? {};

    if (!token || !serviceDate || !type) {
      return NextResponse.json({ error: "token, serviceDate, type 필수" }, { status: 400 });
    }
    const VALID_TYPES = ["REMOVE", "LOCATION", "ORDER", "OTHER"];
    if (!VALID_TYPES.includes(type)) {
      return NextResponse.json({ error: "유효하지 않은 type" }, { status: 400 });
    }

    // 유효한 토큰인지 확인
    const links = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "ShuttleRunLink" WHERE token = $1 LIMIT 1`,
      token,
    );
    if (!links.length) {
      return NextResponse.json({ error: "유효하지 않은 토큰" }, { status: 403 });
    }
    if (await driverLinkBlocked()) return driverLinkDisabledResponse();

    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "DriverRequest" (token, "serviceDate", type, "targetId", "targetName", note, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id`,
      token,
      serviceDate,
      type,
      targetId ?? null,
      targetName ? String(targetName).slice(0, 100) : null,
      note ? String(note).slice(0, 500) : null,
      payload != null ? JSON.stringify(payload) : null,
    );

    return NextResponse.json({ ok: true, id: rows[0]?.id });
  } catch (e) {
    console.error("[driver/request POST]", e);
    return NextResponse.json({ error: "요청 전송 실패" }, { status: 500 });
  }
}
