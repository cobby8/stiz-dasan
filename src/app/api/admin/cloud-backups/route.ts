/**
 * /api/admin/cloud-backups
 *
 * GET    Supabase Storage "backups/" 버킷의 파일 목록을 반환한다.
 *        files = 설정 백업(복원 가능) · archives = 업무 자료 파일(stiz-archive-*.json.gz, 보관용)
 * GET ?archive=<파일이름>  업무 자료 파일을 1분짜리 내려받기 주소로 돌려준다(원장만, 이름 규칙 검사).
 * POST   특정 백업 파일로 DB를 복원한다. body: { filename: string }
 * DELETE 특정 백업 파일을 삭제한다. body: { filename: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOwner } from "@/lib/auth-guard";
import { ARCHIVE_BACKUP_NAME } from "@/lib/backup/archiveCore";

export const dynamic = "force-dynamic";

const BUCKET = "backups";

// GET: 백업 파일 목록 (또는 ?archive= 업무 자료 파일 내려받기 주소)
export async function GET(req: NextRequest) {
    // 원장 권한이 있는 사용자만 백업 목록을 조회할 수 있다.
    try {
        await requireOwner();
    } catch {
        return NextResponse.json({ error: "원장 권한이 필요합니다." }, { status: 403 });
    }

    // 업무 자료 파일 내려받기 — 파일이 수십 MB 라 함수 응답(4.5MB 상한)으로 넘기지 않고 1분짜리 서명 주소를 준다.
    const archiveName = req.nextUrl.searchParams.get("archive");
    if (archiveName !== null) {
        // 이름 규칙에 맞는 업무 자료 파일만 — 다른 경로·파일을 받는 데 쓰이지 않게.
        if (!ARCHIVE_BACKUP_NAME.test(archiveName)) {
            return NextResponse.json({ error: "잘못된 파일 이름입니다." }, { status: 400 });
        }
        try {
            const supabase = createAdminClient();
            const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(archiveName, 60, { download: true });
            if (error || !data?.signedUrl) throw new Error("SIGNED_URL_FAILED");
            return NextResponse.json({ url: data.signedUrl });
        } catch {
            console.error("[cloud-backups GET archive] failed");
            return NextResponse.json({ error: "업무 자료 파일을 준비하지 못했습니다." }, { status: 500 });
        }
    }

    try {
        const supabase = createAdminClient();
        const { data: files, error } = await supabase.storage
            .from(BUCKET)
            .list("", { limit: 200, sortBy: { column: "created_at", order: "desc" } });

        if (error) {
            // 버킷이 아직 없으면 빈 목록을 반환한다. 오류 상황은 아니다.
            if (error.message.includes("not found") || error.message.includes("does not exist")) {
                return NextResponse.json({ files: [] });
            }
            throw error;
        }

        const result = (files ?? []).map((f) => ({
            filename: f.name,
            size: f.metadata?.size ?? 0,
            createdAt: f.created_at,
        }));

        // 업무 자료 파일은 «복원» 목록에서 뺀다 — 최신 자동백업 복원이 files[0] 을 쓰므로 섞이면 복원이 깨진다.
        return NextResponse.json({
            files: result.filter((f) => !f.filename.startsWith("stiz-archive-")),
            archives: result.filter((f) => ARCHIVE_BACKUP_NAME.test(f.filename)),
        });
    } catch (e) {
        console.error("[cloud-backups GET] failed:", e);
        return NextResponse.json({ error: "서버 오류가 발생했습니다." }, { status: 500 });
    }
}

// POST: 클라우드 백업 파일로 DB 복원
export async function POST(req: NextRequest) {
    // 원장 권한이 있는 사용자만 백업을 복원할 수 있다.
    try {
        await requireOwner();
    } catch {
        return NextResponse.json({ error: "원장 권한이 필요합니다." }, { status: 403 });
    }

    let filename: string;
    try {
        const body = await req.json();
        filename = body.filename;
        if (!filename) throw new Error("filename required");
    } catch (e) {
        console.error("[cloud-backups POST] parse error:", e);
        return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
    }

    // 업무 자료 파일은 보관용 — 자동 복원하지 않는다.
    if (filename.startsWith("stiz-archive-")) {
        return NextResponse.json({ error: "업무 자료 파일은 자동 복원하지 않습니다." }, { status: 400 });
    }

    try {
        const supabase = createAdminClient();

        // 백업 파일 다운로드
        const { data, error } = await supabase.storage.from(BUCKET).download(filename);
        if (error) throw new Error(`다운로드 실패: ${error.message}`);

        const text = await data.text();
        const backup = JSON.parse(text);

        if (!backup?._meta?.version) {
            return NextResponse.json({ error: "유효하지 않은 백업 파일입니다." }, { status: 400 });
        }

        const results: Record<string, string> = {};

        // ⚠️ 복원 범위는 기존 설정 칸뿐이다. 업무 자료(학생·출결·청구 등, stiz-archive-* 파일)는
        // 일부러 읽지 않는다 — 운영 자료를 통째로 덮어쓰면 그 사이 쌓인 출결·결제가 사라진다.

        // AcademySettings 복원
        if (backup.academySettings) {
            const s = backup.academySettings;
            try {
                await prisma.$executeRawUnsafe(
                    `INSERT INTO "AcademySettings" (id, "termsOfService", "updatedAt")
                     VALUES ('singleton', $1, NOW())
                     ON CONFLICT (id) DO UPDATE SET
                         "termsOfService" = EXCLUDED."termsOfService",
                         "updatedAt" = NOW()`,
                    s.termsOfService ?? null,
                );
                results.academySettings = "복원됨";
            } catch (e) {
                results.academySettings = `실패: ${(e as Error).message}`;
            }
        }

        // Programs 복원
        if (Array.isArray(backup.programs)) {
            let ok = 0;
            for (const p of backup.programs) {
                try {
                    await prisma.$executeRawUnsafe(
                        `INSERT INTO "Program" (
                            id, name, "targetAge", frequency, "weeklyFrequency", description,
                            price, "order", days,
                            "priceWeek1", "priceWeek2", "priceWeek3", "priceDaily",
                            "shuttleFeeOverride", "createdAt", "updatedAt"
                        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
                        ON CONFLICT (id) DO UPDATE SET
                            name=EXCLUDED.name, "targetAge"=EXCLUDED."targetAge",
                            frequency=EXCLUDED.frequency, "weeklyFrequency"=EXCLUDED."weeklyFrequency",
                            description=EXCLUDED.description, price=EXCLUDED.price,
                            "order"=EXCLUDED."order", days=EXCLUDED.days,
                            "priceWeek1"=EXCLUDED."priceWeek1", "priceWeek2"=EXCLUDED."priceWeek2",
                            "priceWeek3"=EXCLUDED."priceWeek3", "priceDaily"=EXCLUDED."priceDaily",
                            "shuttleFeeOverride"=EXCLUDED."shuttleFeeOverride", "updatedAt"=NOW()`,
                        p.id, p.name, p.targetAge ?? null, p.frequency ?? null,
                        p.weeklyFrequency ?? null, p.description ?? null,
                        p.price ?? 0, p.order ?? 0, p.days ?? null,
                        p.priceWeek1 ?? null, p.priceWeek2 ?? null,
                        p.priceWeek3 ?? null, p.priceDaily ?? null,
                        p.shuttleFeeOverride ?? null,
                        p.createdAt ?? new Date(), p.updatedAt ?? new Date(),
                    );
                    ok++;
                } catch {}
            }
            results.programs = `${ok}/${backup.programs.length}개`;
        }

        // Coaches 복원
        if (Array.isArray(backup.coaches)) {
            let ok = 0;
            for (const c of backup.coaches) {
                try {
                    await prisma.$executeRawUnsafe(
                        `INSERT INTO "Coach" (id, name, role, description, "imageUrl", "order", "createdAt", "updatedAt")
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                         ON CONFLICT (id) DO UPDATE SET
                             name=EXCLUDED.name, role=EXCLUDED.role,
                             description=EXCLUDED.description, "imageUrl"=EXCLUDED."imageUrl",
                             "order"=EXCLUDED."order", "updatedAt"=NOW()`,
                        c.id, c.name, c.role, c.description ?? null,
                        c.imageUrl ?? null, c.order ?? 0,
                        c.createdAt ?? new Date(), c.updatedAt ?? new Date(),
                    );
                    ok++;
                } catch {}
            }
            results.coaches = `${ok}/${backup.coaches.length}개`;
        }

        // ClassSlotOverrides 복원
        if (Array.isArray(backup.classSlotOverrides)) {
            let ok = 0;
            for (const s of backup.classSlotOverrides) {
                try {
                    await prisma.$executeRawUnsafe(
                        `INSERT INTO "ClassSlotOverride" (
                            id, "slotKey", label, note, "isHidden", capacity,
                            "startTimeOverride", "endTimeOverride",
                            "coachId", "programId", "createdAt", "updatedAt"
                        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                        ON CONFLICT ("slotKey") DO UPDATE SET
                            label=EXCLUDED.label, note=EXCLUDED.note,
                            "isHidden"=EXCLUDED."isHidden", capacity=EXCLUDED.capacity,
                            "startTimeOverride"=EXCLUDED."startTimeOverride",
                            "endTimeOverride"=EXCLUDED."endTimeOverride",
                            "coachId"=EXCLUDED."coachId", "programId"=EXCLUDED."programId",
                            "updatedAt"=NOW()`,
                        s.id, s.slotKey, s.label ?? null, s.note ?? null,
                        s.isHidden ?? false, s.capacity ?? 12,
                        s.startTimeOverride ?? null, s.endTimeOverride ?? null,
                        s.coachId ?? null, s.programId ?? null,
                        s.createdAt ?? new Date(), s.updatedAt ?? new Date(),
                    );
                    ok++;
                } catch {}
            }
            results.classSlotOverrides = `${ok}/${backup.classSlotOverrides.length}개`;
        }

        // CustomClassSlots 복원
        if (Array.isArray(backup.customClassSlots)) {
            let ok = 0;
            for (const s of backup.customClassSlots) {
                try {
                    await prisma.$executeRawUnsafe(
                        `INSERT INTO "CustomClassSlot" (
                            id, "dayKey", "startTime", "endTime", label, "gradeRange",
                            enrolled, capacity, note, "isHidden",
                            "coachId", "programId", "createdAt", "updatedAt"
                        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                        ON CONFLICT (id) DO UPDATE SET
                            "dayKey"=EXCLUDED."dayKey", "startTime"=EXCLUDED."startTime",
                            "endTime"=EXCLUDED."endTime", label=EXCLUDED.label,
                            "gradeRange"=EXCLUDED."gradeRange", enrolled=EXCLUDED.enrolled,
                            capacity=EXCLUDED.capacity, note=EXCLUDED.note,
                            "isHidden"=EXCLUDED."isHidden",
                            "coachId"=EXCLUDED."coachId", "programId"=EXCLUDED."programId",
                            "updatedAt"=NOW()`,
                        s.id, s.dayKey, s.startTime, s.endTime, s.label,
                        s.gradeRange ?? null, s.enrolled ?? 0, s.capacity ?? 12,
                        s.note ?? null, s.isHidden ?? false,
                        s.coachId ?? null, s.programId ?? null,
                        s.createdAt ?? new Date(), s.updatedAt ?? new Date(),
                    );
                    ok++;
                } catch {}
            }
            results.customClassSlots = `${ok}/${backup.customClassSlots.length}개`;
        }

        return NextResponse.json({
            success: true,
            restoredFrom: filename,
            restoredAt: new Date().toISOString(),
            results,
        });
    } catch (e) {
        console.error("[cloud-backups POST] restore failed:", e);
        return NextResponse.json({ error: "서버 오류가 발생했습니다." }, { status: 500 });
    }
}

// DELETE: 백업 파일 삭제
export async function DELETE(req: NextRequest) {
    // 원장 권한이 있는 사용자만 백업 파일을 삭제할 수 있다.
    try {
        await requireOwner();
    } catch {
        return NextResponse.json({ error: "원장 권한이 필요합니다." }, { status: 403 });
    }

    let filename: string;
    try {
        const body = await req.json();
        filename = body.filename;
        if (!filename) throw new Error("filename required");
    } catch (e) {
        console.error("[cloud-backups DELETE] parse error:", e);
        return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
    }

    try {
        const supabase = createAdminClient();
        const { error } = await supabase.storage.from(BUCKET).remove([filename]);
        if (error) throw error;
        return NextResponse.json({ success: true, deleted: filename });
    } catch (e) {
        console.error("[cloud-backups DELETE] failed:", e);
        return NextResponse.json({ error: "서버 오류가 발생했습니다." }, { status: 500 });
    }
}
