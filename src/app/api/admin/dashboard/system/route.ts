import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { ARCHIVE_BACKUP_NAME } from "@/lib/backup/archiveCore";
import { SEED_DIR, SEED_LATEST_NAME } from "@/lib/backup/seedSnapshot";

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
        const { data: listed } = await supabase.storage.from("backups").list("", {
            limit: 50,
            sortBy: { column: "created_at", order: "desc" },
        });
        // "seed" 는 핵심 데이터 스냅샷 폴더(파일 아님) — 날짜가 없어 «백업 없음»으로 오판하지 않게 뺀다.
        const allFiles = listed?.filter((f) => f.name !== SEED_DIR);
        // 핵심 데이터 스냅샷(seed/seed-latest.json)이 마지막으로 저장된 시각 — 매일 덮어쓰므로 «고친 시각»을 본다.
        // 파일을 내려받지 않는다. 없거나 조회 실패면 null 로 두고 카드에서 줄을 숨긴다.
        let seedSnapshotAt: string | null = null;
        try {
            const { data: seedFiles } = await supabase.storage.from("backups").list(SEED_DIR, { limit: 10, search: "seed-latest" });
            const latestSeed = seedFiles?.find((f) => f.name === SEED_LATEST_NAME);
            seedSnapshotAt = latestSeed?.updated_at ?? latestSeed?.created_at ?? null;
        } catch {
            seedSnapshotAt = null;
        }
        const latest = allFiles?.[0];
        const lastBackupAt = latest?.created_at ? new Date(latest.created_at) : null;
        // 설정 파일 개수(업무 자료 짝 파일은 따로 센다)
        const backupCount = allFiles?.filter((f) => !ARCHIVE_BACKUP_NAME.test(f.name)).length ?? 0;
        // 최신 업무 자료 파일(stiz-archive-*.json.gz)에 얼마나 담겼는지 — 백업할 때 파일 정보(metadata)에 적어 둔 값을 읽는다.
        // 파일을 내려받지 않는다(수십 MB). 없거나 조회 실패면 null 로 두고 카드에서 줄을 숨긴다.
        const latestArchive = allFiles?.find((f) => ARCHIVE_BACKUP_NAME.test(f.name));
        let archive: { tables: number; rows: number; complete: boolean } | null = null;
        if (latestArchive?.name) {
            try {
                const { data: info } = await supabase.storage.from("backups").info(latestArchive.name);
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
            lastBackupBytes: typeof latestArchive?.metadata?.size === "number" ? latestArchive.metadata.size : null,
            archive,
            seedSnapshotAt,
        };
    } catch {
        return { lastBackupAt: null, backupCount: 0, lastBackupBytes: null, archive: null, seedSnapshotAt: null };
    }
}

const getCachedSystemStatus = unstable_cache(
    async () => {
        const [dbOk, backup] = await Promise.all([getDbStatus(), getBackupStatus()]);
        return { dbOk, backup };
    },
    ["admin-dashboard-system-status-v3"],
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
