/**
 * GET /api/admin/export-seed
 *
 * 현재 DB의 Programs, ClassSlotOverrides, AcademySettings(termsOfService)를
 * prisma/seed-data.ts에 붙여 넣을 수 있는 TypeScript 코드로 내보낸다(수동 내려받기).
 *
 * 2026-11-16: 이 버튼을 누르지 않아도 된다 — 같은 자료를 매일 자동 백업(/api/cron/backup)이
 * Storage "backups/seed/seed-latest.json" 에 저장하고, 복구(/api/admin/seed)가 그 최신본을 먼저 쓴다.
 * 자료를 고르는 규칙은 자동 저장과 같은 함수(buildSeedSnapshot)를 쓴다.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth-guard";
import { buildSeedSnapshot, renderSeedDataTs } from "@/lib/backup/seedSnapshot";

export const dynamic = "force-dynamic";

export async function GET() {
    // 원장 권한이 있는 사용자만 시드 데이터를 내보낼 수 있다.
    try {
        await requireOwner();
    } catch {
        return NextResponse.json({ error: "원장 권한이 필요합니다." }, { status: 403 });
    }

    try {
        const [programRows, slotRows, settingsRows] = await Promise.all([
            prisma.$queryRawUnsafe<any[]>(
                `SELECT id, name, "targetAge", description, days,
                        "priceWeek1", "priceWeek2", "priceWeek3", "priceDaily",
                        "shuttleFeeOverride", "order",
                        frequency, "weeklyFrequency", "imageUrl", "runsShuttle", "deletedAt"
                 FROM "Program" ORDER BY "order" ASC, "createdAt" ASC`
            ).catch(() => [] as any[]),
            prisma.$queryRawUnsafe<any[]>(
                `SELECT id, "slotKey", label, note, "isHidden", capacity,
                        "startTimeOverride", "endTimeOverride", "coachId", "programId"
                 FROM "ClassSlotOverride" ORDER BY "slotKey" ASC`
            ).catch(() => [] as any[]),
            prisma.$queryRawUnsafe<any[]>(
                `SELECT "termsOfService" FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`
            ).catch(() => [] as any[]),
        ]);

        const terms = settingsRows[0]?.termsOfService ?? settingsRows[0]?.termsofservice ?? null;

        // 자동 저장과 같은 규칙으로 칸을 고른 뒤, seed-data.ts 코드 모양으로 바꾼다.
        const snapshot = buildSeedSnapshot(
            { programRows, slotRows, termsOfService: terms },
            { exportedAt: new Date().toISOString(), source: "export" },
        );
        const code = renderSeedDataTs(snapshot, new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }));

        return new NextResponse(code, {
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Disposition": `attachment; filename="seed-data.ts"`,
            },
        });
    } catch (e) {
        return NextResponse.json({ error: "서버 오류가 발생했습니다." }, { status: 500 });
    }
}
