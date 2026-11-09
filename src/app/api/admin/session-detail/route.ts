import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";

/**
 * GET /api/admin/session-detail?sessionId=xxx
 *
 * 세션 상세 조회 API (수정 모드용)
 * - 세션의 content 필드 + 출석 상세 데이터를 반환
 * - getSessionDetail(서버 cache 함수)를 클라이언트에서 사용할 수 없으므로 API로 제공
 */
export async function GET(request: NextRequest) {
    try {
        await requireAdmin();
    } catch {
        return NextResponse.json({ error: "관리자 권한 필요" }, { status: 403 });
    }

    const sessionId = request.nextUrl.searchParams.get("sessionId");
    if (!sessionId) {
        return NextResponse.json({ error: "sessionId required" }, { status: 400 });
    }

    try {
        // 세션 기본 정보 조회 ($queryRawUnsafe — PgBouncer 호환)
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT se.id, se."classId", se.date, se.topic, se.content, se.notes,
                    se."photosJSON", se."coachId",
                    (se."specialProgramSessionDateId" IS NOT NULL) AS "isSeasonal"
             FROM "Session" se
             WHERE se.id = $1`,
            sessionId
        );

        if (!rows[0]) {
            return NextResponse.json({ error: "세션을 찾을 수 없습니다" }, { status: 404 });
        }

        const r = rows[0];

        // 해당 세션의 출석 데이터 조회
        const attRows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT "studentId", status FROM "Attendance" WHERE "sessionId" = $1`,
            sessionId
        );

        // photosJSON 파싱
        let photos: string[] = [];
        const photosJSON = r.photosJSON ?? r.photosjson ?? null;
        if (photosJSON) {
            try {
                const parsed = JSON.parse(photosJSON);
                if (Array.isArray(parsed)) {
                    photos = parsed.map((p: any) => (typeof p === "string" ? p : p?.url ?? "")).filter(Boolean);
                }
            } catch {
                // JSON 파싱 실패 시 빈 배열
            }
        }

        return NextResponse.json({
            id: r.id,
            date: r.date ? new Date(r.date).toISOString().split("T")[0] : "",
            topic: r.topic ?? "",
            content: r.content ?? "",
            coachId: r.coachId ?? r.coachid ?? "",
            photos,
            // 방학특강 회차 기록이면 화면에서 정규반 출석 칸을 숨긴다(특강 출석은 좌석 기준이라 따로 관리)
            isSeasonal: Boolean(r.isSeasonal ?? r.isseasonal),
            attendances: attRows.map((a: any) => ({
                studentId: a.studentId ?? a.studentid,
                status: a.status,
            })),
        });
    } catch (e: any) {
        console.error("[session-detail] failed:", e);
        return NextResponse.json({ error: "조회 실패" }, { status: 500 });
    }
}
