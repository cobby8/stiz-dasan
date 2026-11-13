/**
 * GET /api/cron/backup
 *
 * Vercel Cron이 매일 KST 자정(UTC 15:00)에 호출합니다.
 * 설정 7개 테이블(복원 대상)은 stiz-backup-<시각>.json, 나머지 업무 자료 전체(보관용)는
 * stiz-archive-<시각>.json.gz 로 Supabase Storage "backups/" 버킷에 저장합니다.
 * 복원은 설정 파일만 — 업무 자료 파일은 자동 복원하지 않습니다.
 * 30일이 지난 백업은 자동 삭제됩니다.
 *
 * vercel.json:
 *   "crons": [{ "path": "/api/cron/backup", "schedule": "0 15 * * *" }]
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import {
    ARCHIVE_BACKUP_NAME, SETTINGS_BACKUP_NAME, archiveFilenameFor, backupReplacer, collectBackupArchive, packArchive,
} from "@/lib/backup/archive";
import { withCronAlert } from "@/lib/cron/withCronAlert";

export const dynamic = "force-dynamic";
// 업무 자료 전체(수만 줄)를 읽고 압축한다 — 60초로는 빠듯해 300초(Pro 상한). vercel.json 에도 같은 값.
export const maxDuration = 300;

const BUCKET = "backups";
const KEEP_DAYS = 30;

async function requiredQuery(sql: string): Promise<Record<string, unknown>[]> {
    // 조회 실패와 정상적인 0건을 구별한다. 실패하면 저장과 과거 백업 정리를 중단한다.
    return prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql);
}

async function handleGet(req: NextRequest) {
    // Cron 인증 필수화 — CRON_SECRET 없으면 무조건 거부 (개발환경 예외)
    const cronSecret = process.env.CRON_SECRET;
    if (process.env.NODE_ENV !== "development") {
        if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
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

        // 설정 조회가 모두 성공한 뒤 업무 자료(학생·수강·출결·청구·결제 등)를 보관용으로 모은다.
        // 예외를 던지지 않는다 — 실패한 표는 archive.failed 에 남고, 설정 백업은 그대로 저장한다.
        stage = "ARCHIVE";
        const archive = await collectBackupArchive();

        const routesWithStops = routes.map((r) => ({
            ...r,
            stops: stops.filter((s) => s.routeId === r.id),
        }));

        // 3. 파일 이름 — 설정 파일과 같은 시각의 업무 자료 파일(.json.gz)을 짝으로 둔다
        const now = new Date();
        const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
        const filename = `stiz-backup-${kstNow.toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
        const archiveFilename = archiveFilenameFor(filename);
        const exportedAt = now.toISOString();

        // 업무 자료 파일(gzip) — 상한을 넘으면 큰 표부터 빼고 나머지를 담는다(빠진 표 = SIZE_LIMIT)
        const { body: archiveBody, summary } = packArchive(archive, { exportedAt, source: "cron", settingsFile: filename });

        const snapshot = {
            _meta: {
                version: 1,
                exportedAt,
                source: "cron",
                // 이 파일은 설정 7개 표뿐(복원 대상). 업무 자료는 짝 파일 archiveFile 에 있다(보관용·자동 복원 안 함).
                scope: "SETTINGS_ONLY",
                tables: ["AcademySettings", "Program", "Coach", "ClassSlotOverride", "CustomClassSlot", "Route/Stop"],
                archiveFile: archiveFilename,
                archive: { tables: summary.tables, rows: summary.rows, complete: summary.complete },
            },
            academySettings: academyRows[0] ?? null,
            programs,
            coaches,
            classSlotOverrides,
            customClassSlots,
            routes: routesWithStops,
        };

        const body = JSON.stringify(snapshot, backupReplacer, 2);
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

        // 3-2. 업무 자료 파일 — 실패해도 설정 파일은 이미 저장됐다. 결과만 기록하고 정리까지 진행한다.
        stage = "ARCHIVE_UPLOAD";
        let archiveSaved: boolean | null = false;
        try {
            const { error: archiveError } = await supabase.storage.from(BUCKET).upload(archiveFilename, archiveBody, {
                contentType: "application/gzip",
                upsert: false,
                // 대시보드 «시스템 상태»가 파일을 내려받지 않고 담긴 표·행 수를 보도록 파일 정보에 적는다.
                metadata: { archiveTables: summary.tables, archiveRows: summary.rows, archiveComplete: summary.complete },
            });
            archiveSaved = !archiveError;
        } catch {
            archiveSaved = null; // 응답 유실 — 저장됐을 수도 있다
        }

        // 4. 30일 이상 된 파일 삭제 (설정 파일·업무 자료 파일 둘 다)
        stage = "CLEANUP_LIST";
        const { data: files, error: listError } = await supabase.storage.from(BUCKET).list("", { limit: 200 });
        if (listError || !files) throw new Error("CLEANUP_LIST_FAILED");
        const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
        const toDelete = files.filter((f) => {
            const created = f.created_at ? new Date(f.created_at) : null;
            return (SETTINGS_BACKUP_NAME.test(f.name) || ARCHIVE_BACKUP_NAME.test(f.name))
                && f.name !== filename && f.name !== archiveFilename && created !== null && created < cutoff;
        });
        if (toDelete.length > 0) {
            stage = "CLEANUP_REMOVE";
            const names = toDelete.map((f) => f.name);
            const { data: removed, error: removeError } = await supabase.storage.from(BUCKET).remove(names);
            if (removeError || !removed) throw new Error("CLEANUP_REMOVE_FAILED");
            deleted = names.filter((name) => removed.some((file) => file.name === name));
            if (deleted.length !== names.length) throw new Error("CLEANUP_REMOVE_INCOMPLETE");
        }

        const archiveResult = { filename: archiveFilename, saved: archiveSaved, tables: summary.tables, rows: summary.rows,
            bytes: summary.bytes, complete: summary.complete, failedTables: summary.failedTables };
        if (!summary.complete || archiveSaved !== true) {
            // 설정은 저장됐지만 업무 자료 일부(또는 파일)를 못 담았다 — 500 으로 알려 원장 슬랙 알림이 가게 한다.
            console.error("[cron/backup] archive incomplete:", summary.failedTables.length, archiveSaved);
            return NextResponse.json({ success: false, scope: "SETTINGS_ONLY", stage: "ARCHIVE_INCOMPLETE",
                backupSaved: true, filename, deleted, archive: archiveResult,
                error: "설정은 저장했지만 업무 자료 일부를 백업하지 못했습니다." }, { status: 500 });
        }

        return NextResponse.json({
            success: true,
            scope: "SETTINGS_ONLY",
            filename,
            archive: archiveResult,
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
        console.error("[cron/backup] failed:", stage);
        return NextResponse.json({ success: false, scope: "SETTINGS_ONLY", stage,
            // 응답 유실은 미저장으로 확정하지 않는다. 후보 파일을 재조회해야 한다.
            backupSaved: savedFilename !== null ? true : intendedFilename !== null ? null : false,
            filename: savedFilename ?? intendedFilename, deleted,
            error: "백업 작업을 완료하지 못했습니다." }, { status: 500 });
    }
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("backup", handleGet);
