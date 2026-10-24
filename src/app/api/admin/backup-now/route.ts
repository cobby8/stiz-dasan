/** 원장 전용 수동 설정 백업. 학생·청구·월 장부 전체 백업은 아닙니다. */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOwner } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";
const BUCKET = "backups";
const KEEP_DAYS = 30;
function replacer(_: string, v: unknown) {
    return typeof v === "bigint" ? Number(v) : v;
}
async function requiredQuery(sql: string): Promise<Record<string, unknown>[]> {
    return prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql);
}
export async function POST() {
    try {
        await requireOwner();
    } catch {
        return NextResponse.json({ error: "원장 권한이 필요합니다." }, { status: 403 });
    }

    let stage = "COLLECT";
    let savedFilename: string | null = null;
    let intendedFilename: string | null = null;
    let deleted: string[] = [];
    try {
        // 모든 필수 조회가 성공하기 전에는 Storage에 쓰지 않는다.
        const [academyRows, programs, coaches, classSlotOverrides, customClassSlots, routes, stops] =
            await Promise.all([
                requiredQuery(`SELECT * FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`),
                requiredQuery(`SELECT * FROM "Program" ORDER BY "order" ASC, "createdAt" ASC`),
                requiredQuery(`SELECT * FROM "Coach" ORDER BY "order" ASC`),
                requiredQuery(`SELECT * FROM "ClassSlotOverride" ORDER BY "slotKey" ASC`),
                requiredQuery(`SELECT * FROM "CustomClassSlot" ORDER BY "dayKey" ASC, "startTime" ASC`),
                requiredQuery(`SELECT * FROM "Route"`),
                requiredQuery(`SELECT * FROM "Stop" ORDER BY "createdAt" ASC`),
            ]);

        const routesWithStops = routes.map((r) => ({
            ...r,
            stops: stops.filter((s) => s.routeId === r.id),
        }));

        const snapshot = {
            _meta: {
                version: 1,
                exportedAt: new Date().toISOString(),
                source: "manual",
                scope: "SETTINGS_ONLY",
                tables: ["AcademySettings", "Program", "Coach", "ClassSlotOverride", "CustomClassSlot", "Route/Stop"],
            },
            academySettings: academyRows[0] ?? null,
            programs,
            coaches,
            classSlotOverrides,
            customClassSlots,
            routes: routesWithStops,
        };

        // 3. Supabase Storage에 업로드
        const now = new Date();
        const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
        const filename = `stiz-backup-${kstNow.toISOString().slice(0, 19).replace(/:/g, "-")}.json`;

        const body = JSON.stringify(snapshot, replacer, 2);
        stage = "BUCKET";
        const supabase = createAdminClient();
        const { data: buckets, error: bucketError } = await supabase.storage.listBuckets();
        if (bucketError || !buckets) throw new Error("BUCKET_LIST_FAILED");
        if (!buckets.some((b) => b.name === BUCKET)) {
            const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
            if (error) throw new Error("BUCKET_CREATE_FAILED");
        }
        stage = "UPLOAD";
        intendedFilename = filename;
        const { error: uploadError } = await supabase.storage
            .from(BUCKET)
            .upload(filename, body, { contentType: "application/json", upsert: false });

        if (uploadError) throw new Error("UPLOAD_FAILED");
        savedFilename = filename;

        // 4. 30일 이상 된 파일 삭제
        stage = "CLEANUP_LIST";
        const { data: files, error: listError } = await supabase.storage.from(BUCKET).list("", { limit: 200 });
        if (listError || !files) throw new Error("CLEANUP_LIST_FAILED");
        const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
        const toDelete = files.filter((f) => {
            const created = f.created_at ? new Date(f.created_at) : null;
            return /^stiz-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/.test(f.name)
                && f.name !== filename && created !== null && created < cutoff;
        });
        if (toDelete.length > 0) {
            stage = "CLEANUP_REMOVE";
            const names = toDelete.map((f) => f.name);
            const { data: removed, error: removeError } = await supabase.storage.from(BUCKET).remove(names);
            if (removeError || !removed) throw new Error("CLEANUP_REMOVE_FAILED");
            deleted = names.filter((name) => removed.some((file) => file.name === name));
            if (deleted.length !== names.length) throw new Error("CLEANUP_REMOVE_INCOMPLETE");
        }

        return NextResponse.json({
            success: true,
            scope: "SETTINGS_ONLY",
            filename,
            rows: {
                programs: programs.length,
                coaches: coaches.length,
                classSlotOverrides: classSlotOverrides.length,
                customClassSlots: customClassSlots.length,
            },
            deleted,
        });
    } catch {
        // DB/Storage 예외에는 연결정보나 자료가 포함될 수 있어 원문을 남기지 않는다.
        console.error("[backup-now] failed:", stage);
        return NextResponse.json({ success: false, scope: "SETTINGS_ONLY", stage,
            // 응답 유실은 미저장으로 확정하지 않는다. 후보 파일을 재조회해야 한다.
            backupSaved: savedFilename !== null ? true : intendedFilename !== null ? null : false,
            filename: savedFilename ?? intendedFilename, deleted,
            error: "설정 백업 작업을 완료하지 못했습니다." }, { status: 500 });
    }
}
