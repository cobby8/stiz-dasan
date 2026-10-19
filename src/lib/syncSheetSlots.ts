/**
 * Google Sheets → SheetSlotCache DB 동기화 공유 로직
 *
 * 두 곳에서 호출됨:
 *  - GET  /api/cron/sync-schedule  (Vercel Cron, CRON_SECRET 인증)
 *  - POST /api/admin/sync-schedule (관리자 수동 동기화)
 */

import { prisma } from "@/lib/prisma";
import { fetchSheetScheduleNoCache } from "@/lib/googleSheetsSchedule";

export async function syncSheetSlots(): Promise<{ synced: number; syncedAt: string } | { error: string }> {
    // 1. 구글 시트 URL 조회
    let sheetUrl: string | null = null;
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT "googleSheetsScheduleUrl" FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`
        );
        sheetUrl = rows[0]?.googleSheetsScheduleUrl ?? rows[0]?.googlesheetsscheduleurl ?? null;
    } catch {
        return { error: "시간표 설정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." };
    }

    if (!sheetUrl) {
        return { error: "연결할 구글 시트를 학원 설정에서 먼저 등록해 주세요." };
    }

    // 2. 구글 시트 CSV 파싱 (캐시 없이 최신 데이터)
    const slots = await fetchSheetScheduleNoCache(sheetUrl);

    // 3. SheetSlotCache 테이블에 upsert
    const slotsJson = JSON.stringify(slots);
    const now = new Date().toISOString();
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "SheetSlotCache" (id, "slotsJson", "syncedAt")
             VALUES ('singleton', $1, now())
             ON CONFLICT (id) DO UPDATE SET "slotsJson" = $1, "syncedAt" = now()`,
            slotsJson
        );
    } catch {
        return { error: "시간표를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요." };
    }

    return { synced: slots.length, syncedAt: now };
}
