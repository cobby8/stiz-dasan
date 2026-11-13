import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth-guard";
import { collectBackupArchive, DOWNLOAD_MAX_BYTES, serializeBackup } from "@/lib/backup/archive";

export const dynamic = "force-dynamic";

async function requiredQuery(sql: string): Promise<Record<string, unknown>[]> {
    // 조회 실패를 빈 정상 자료로 바꾸지 않는다. 실패 응답에는 첨부파일을 만들지 않는다.
    return prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql);
}

// GET /api/admin/backup - 설정 7개 표(복원 대상) + 업무 자료 전체(보관용 archive 칸, 자동 복원 안 함) 다운로드
export async function GET() {
    // 원장 권한이 있는 사용자만 백업을 다운로드할 수 있다.
    try {
        await requireOwner();
    } catch {
        return NextResponse.json({ error: "원장 권한이 필요합니다." }, { status: 403 });
    }

    try {
        const [
            academySettingsRows,
            programs,
            coaches,
            classSlotOverrides,
            customClassSlots,
            routes,
            stops,
        ] = await Promise.all([
            requiredQuery(`SELECT * FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`),
            requiredQuery(`SELECT * FROM "Program" ORDER BY "order" ASC, "createdAt" DESC`),
            requiredQuery(`SELECT * FROM "Coach" ORDER BY "order" ASC`),
            requiredQuery(`SELECT * FROM "ClassSlotOverride" ORDER BY "slotKey" ASC`),
            requiredQuery(`SELECT * FROM "CustomClassSlot" ORDER BY "dayKey" ASC, "startTime" ASC`),
            requiredQuery(`SELECT * FROM "Route"`),
            requiredQuery(`SELECT * FROM "Stop" ORDER BY "createdAt" ASC`),
        ]);

        // 업무 자료(학생·수강·출결·청구·결제 등)를 보관용으로 모은다. 실패한 표는 archive.failed 에 남는다.
        const archive = await collectBackupArchive();

        // Attach stops to routes
        const routesWithStops = routes.map((r) => ({
            ...r,
            stops: stops.filter((s) => s.routeId === r.id),
        }));

        const backup = {
            _meta: {
                version: 1,
                // 복원(POST)은 그대로 설정 7개 표만. archive 칸은 보관용 — 이 파일로 복원해도 되살리지 않는다.
                scope: "SETTINGS_AND_ARCHIVE",
                restoreScope: "SETTINGS_ONLY",
                exportedAt: new Date().toISOString(),
                tables: ["AcademySettings", "Program", "Coach", "ClassSlotOverride", "CustomClassSlot", "Route/Stop"],
            },
            academySettings: academySettingsRows[0] ?? null,
            programs,
            coaches,
            classSlotOverrides,
            customClassSlots,
            routes: routesWithStops,
            archive,
        };

        const filename = `stiz-backup-${new Date().toISOString().slice(0, 10)}.json`;

        // Vercel 응답 상한 때문에 다운로드는 4MB 까지 — 넘으면 보관용 표 내용은 빠지고(archive.failed 에 SIZE_LIMIT) 설정은 그대로다.
        const { body, summary } = serializeBackup(backup, DOWNLOAD_MAX_BYTES);
        return new NextResponse(body, {
            headers: {
                "Content-Type": "application/json",
                "Content-Disposition": `attachment; filename="${filename}"`,
                // 화면·점검에서 업무 자료가 다 담겼는지 볼 수 있게 요약을 헤더로 알려 준다.
                "X-Backup-Archive": `tables=${summary.tables}; rows=${summary.rows}; complete=${summary.complete}`,
            },
        });
    } catch {
        console.error("[backup GET] failed: COLLECT_OR_SERIALIZE");
        return NextResponse.json({ success: false, scope: "SETTINGS_AND_ARCHIVE", error: "백업 자료를 수집하지 못했습니다." }, { status: 500 });
    }
}

// POST /api/admin/backup - JSON 백업으로 복원
export async function POST(req: NextRequest) {
    // 원장 권한이 있는 사용자만 백업을 복원할 수 있다.
    try {
        await requireOwner();
    } catch {
        return NextResponse.json({ error: "원장 권한이 필요합니다." }, { status: 403 });
    }

    let backup: any;
    try {
        backup = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!backup?._meta?.version) {
        return NextResponse.json({ error: "Not a valid backup file" }, { status: 400 });
    }

    const results: Record<string, string> = {};

    // ⚠️ 복원 범위는 설정 4개 칸(programs·coaches·classSlotOverrides·customClassSlots)뿐이다.
    // backup.archive(학생·출결·청구 등 보관용)는 일부러 읽지 않는다 — 운영 자료를 통째로 덮어쓰면 위험하다.

    // Restore Programs
    if (Array.isArray(backup.programs)) {
        let restored = 0;
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
                        name = EXCLUDED.name,
                        "targetAge" = EXCLUDED."targetAge",
                        frequency = EXCLUDED.frequency,
                        "weeklyFrequency" = EXCLUDED."weeklyFrequency",
                        description = EXCLUDED.description,
                        price = EXCLUDED.price,
                        "order" = EXCLUDED."order",
                        days = EXCLUDED.days,
                        "priceWeek1" = EXCLUDED."priceWeek1",
                        "priceWeek2" = EXCLUDED."priceWeek2",
                        "priceWeek3" = EXCLUDED."priceWeek3",
                        "priceDaily" = EXCLUDED."priceDaily",
                        "shuttleFeeOverride" = EXCLUDED."shuttleFeeOverride",
                        "updatedAt" = NOW()`,
                    p.id, p.name, p.targetAge ?? null, p.frequency ?? null,
                    p.weeklyFrequency ?? null, p.description ?? null,
                    p.price ?? 0, p.order ?? 0, p.days ?? null,
                    p.priceWeek1 ?? null, p.priceWeek2 ?? null,
                    p.priceWeek3 ?? null, p.priceDaily ?? null,
                    p.shuttleFeeOverride ?? null,
                    p.createdAt ?? new Date(), p.updatedAt ?? new Date(),
                );
                restored++;
            } catch (e) {
                console.error(`[backup restore] Program "${p.name}" failed:`, e);
            }
        }
        results.programs = `${restored}/${backup.programs.length}개 복원`;
    }

    // Restore Coaches
    if (Array.isArray(backup.coaches)) {
        let restored = 0;
        for (const c of backup.coaches) {
            try {
                await prisma.$executeRawUnsafe(
                    `INSERT INTO "Coach" (id, name, role, description, "imageUrl", "order", "createdAt", "updatedAt")
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                     ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name, role = EXCLUDED.role,
                        description = EXCLUDED.description, "imageUrl" = EXCLUDED."imageUrl",
                        "order" = EXCLUDED."order", "updatedAt" = NOW()`,
                    c.id, c.name, c.role, c.description ?? null,
                    c.imageUrl ?? null, c.order ?? 0,
                    c.createdAt ?? new Date(), c.updatedAt ?? new Date(),
                );
                restored++;
            } catch (e) {
                console.error(`[backup restore] Coach "${c.name}" failed:`, e);
            }
        }
        results.coaches = `${restored}/${backup.coaches.length}개 복원`;
    }

    // Restore ClassSlotOverrides
    if (Array.isArray(backup.classSlotOverrides)) {
        let restored = 0;
        for (const s of backup.classSlotOverrides) {
            try {
                await prisma.$executeRawUnsafe(
                    `INSERT INTO "ClassSlotOverride" (
                        id, "slotKey", label, note, "isHidden", capacity,
                        "startTimeOverride", "endTimeOverride",
                        "coachId", "programId", "createdAt", "updatedAt"
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                    ON CONFLICT ("slotKey") DO UPDATE SET
                        label = EXCLUDED.label, note = EXCLUDED.note,
                        "isHidden" = EXCLUDED."isHidden", capacity = EXCLUDED.capacity,
                        "startTimeOverride" = EXCLUDED."startTimeOverride",
                        "endTimeOverride" = EXCLUDED."endTimeOverride",
                        "coachId" = EXCLUDED."coachId", "programId" = EXCLUDED."programId",
                        "updatedAt" = NOW()`,
                    s.id, s.slotKey, s.label ?? null, s.note ?? null,
                    s.isHidden ?? false, s.capacity ?? 12,
                    s.startTimeOverride ?? null, s.endTimeOverride ?? null,
                    s.coachId ?? null, s.programId ?? null,
                    s.createdAt ?? new Date(), s.updatedAt ?? new Date(),
                );
                restored++;
            } catch (e) {
                console.error(`[backup restore] Slot "${s.slotKey}" failed:`, e);
            }
        }
        results.classSlotOverrides = `${restored}/${backup.classSlotOverrides.length}개 복원`;
    }

    // Restore CustomClassSlots
    if (Array.isArray(backup.customClassSlots)) {
        let restored = 0;
        for (const s of backup.customClassSlots) {
            try {
                await prisma.$executeRawUnsafe(
                    `INSERT INTO "CustomClassSlot" (
                        id, "dayKey", "startTime", "endTime", label, "gradeRange",
                        enrolled, capacity, note, "isHidden",
                        "coachId", "programId", "createdAt", "updatedAt"
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                    ON CONFLICT (id) DO UPDATE SET
                        "dayKey" = EXCLUDED."dayKey", "startTime" = EXCLUDED."startTime",
                        "endTime" = EXCLUDED."endTime", label = EXCLUDED.label,
                        "gradeRange" = EXCLUDED."gradeRange", enrolled = EXCLUDED.enrolled,
                        capacity = EXCLUDED.capacity, note = EXCLUDED.note,
                        "isHidden" = EXCLUDED."isHidden",
                        "coachId" = EXCLUDED."coachId", "programId" = EXCLUDED."programId",
                        "updatedAt" = NOW()`,
                    s.id, s.dayKey, s.startTime, s.endTime, s.label,
                    s.gradeRange ?? null, s.enrolled ?? 0, s.capacity ?? 12,
                    s.note ?? null, s.isHidden ?? false,
                    s.coachId ?? null, s.programId ?? null,
                    s.createdAt ?? new Date(), s.updatedAt ?? new Date(),
                );
                restored++;
            } catch (e) {
                console.error(`[backup restore] CustomSlot failed:`, e);
            }
        }
        results.customClassSlots = `${restored}/${backup.customClassSlots.length}개 복원`;
    }

    return NextResponse.json({
        success: true,
        restoredAt: new Date().toISOString(),
        results,
    });
}
