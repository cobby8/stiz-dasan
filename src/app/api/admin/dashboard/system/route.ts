import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";

const SYSTEM_STATUS_CACHE_SECONDS = 300;
const SYSTEM_STATUS_CACHE_HEADERS = {
    "Cache-Control": `private, max-age=60, stale-while-revalidate=${SYSTEM_STATUS_CACHE_SECONDS}`,
};

async function getDbStatus() {
    try {
        await prisma.$queryRaw`SELECT 1`;
        return true;
    } catch {
        return false;
    }
}

async function getBackupStatus() {
    try {
        const supabase = createAdminClient();
        const { data: allFiles } = await supabase.storage.from("backups").list("", {
            limit: 50,
            sortBy: { column: "created_at", order: "desc" },
        });
        const latest = allFiles?.[0];
        const lastBackupAt = latest?.created_at ? new Date(latest.created_at) : null;
        const backupCount = allFiles?.length ?? 0;
        // 최신 백업에 업무 자료가 얼마나 담겼는지 — 백업할 때 파일 정보(metadata)에 적어 둔 값을 읽는다.
        // 파일을 내려받지 않는다(수 MB). 예전 파일·조회 실패면 null 로 두고 카드에서 줄을 숨긴다.
        let archive: { tables: number; rows: number; complete: boolean } | null = null;
        if (latest?.name) {
            try {
                const { data: info } = await supabase.storage.from("backups").info(latest.name);
                const meta = (info as { metadata?: Record<string, unknown> } | null)?.metadata;
                if (meta && typeof meta.archiveTables === "number" && typeof meta.archiveRows === "number") {
                    archive = { tables: meta.archiveTables, rows: meta.archiveRows, complete: meta.archiveComplete === true };
                }
            } catch {
                archive = null;
            }
        }
        return {
            lastBackupAt: lastBackupAt?.toISOString() ?? null,
            backupCount,
            lastBackupBytes: typeof latest?.metadata?.size === "number" ? latest.metadata.size : null,
            archive,
        };
    } catch {
        return { lastBackupAt: null, backupCount: 0, lastBackupBytes: null, archive: null };
    }
}

const getCachedSystemStatus = unstable_cache(
    async () => {
        const [dbOk, backup] = await Promise.all([getDbStatus(), getBackupStatus()]);
        return { dbOk, backup };
    },
    ["admin-dashboard-system-status-v2"],
    {
        revalidate: SYSTEM_STATUS_CACHE_SECONDS,
        tags: ["admin-dashboard-system"],
    },
);

export async function GET() {
    try {
        await requireAdmin();
    } catch {
        return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    try {
        const status = await getCachedSystemStatus();

        return NextResponse.json(status, { headers: SYSTEM_STATUS_CACHE_HEADERS });
    } catch (error) {
        console.error("[api/admin/dashboard/system] failed:", error);
        return NextResponse.json({ error: "Failed to load dashboard system status" }, { status: 500 });
    }
}
