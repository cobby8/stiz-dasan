import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

function replacer(_: string, v: unknown) {
    return typeof v === "bigint" ? Number(v) : v;
}

async function requiredQuery(sql: string): Promise<Record<string, unknown>[]> {
    // 조회 실패를 빈 정상 자료로 바꾸지 않는다. 실패 응답에는 첨부파일을 만들지 않는다.
    return prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql);
}

// GET /api/admin/backup - 설정 7개 테이블만 다운로드 (전체 DB 백업 아님)
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

        // Attach stops to routes
        const routesWithStops = routes.map((r) => ({
            ...r,
            stops: stops.filter((s) => s.routeId === r.id),
        }));

        const backup = {
            _meta: {
                version: 1,
                scope: "SETTINGS_ONLY",
                exportedAt: new Date().toISOString(),
                tables: ["AcademySettings", "Program", "Coach", "ClassSlotOverride", "CustomClassSlot", "Route/Stop"],
            },
            academySettings: academySettingsRows[0] ?? null,
            programs,
            coaches,
            classSlotOverrides,
            customClassSlots,
            routes: routesWithStops,
        };

        const filename = `stiz-backup-${new Date().toISOString().slice(0, 10)}.json`;

        return new NextResponse(JSON.stringify(backup, replacer, 2), {
            headers: {
                "Content-Type": "application/json",
                "Content-Disposition": `attachment; filename="${filename}"`,
            },
        });
    } catch {
        console.error("[backup GET] failed: COLLECT_OR_SERIALIZE");
        return NextResponse.json({ success: false, scope: "SETTINGS_ONLY", error: "설정 백업 자료를 수집하지 못했습니다." }, { status: 500 });
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
