/**
 * POST /api/admin/seed
 *
 * 핵심 데이터(프로그램·수업 칸 설정·이용약관)를 DB에 복원한다.
 * DB가 비어 있거나 데이터가 유실됐을 때 복구용으로 사용한다.
 * 이미 존재하는 ID는 upsert로 갱신한다(지우지 않는다).
 *
 * 자료를 고르는 순서(2026-11-16):
 *   1) Storage "backups/seed/seed-latest.json" — 매일 자동 백업이 저장하는 최신 스냅샷
 *   2) 1)이 없거나 읽기 실패·모양 이상·프로그램 0줄이면 → 저장소에 든 prisma/seed-data.ts
 * 응답의 source 로 어느 쪽을 썼는지 알린다.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth-guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadLatestSeedSnapshot, SEED_LATEST_PATH } from "@/lib/backup/seedSnapshot";
import { toKstYmd } from "@/lib/datetime/kst";
import {
    PROGRAMS as FILE_PROGRAMS,
    CLASS_SLOT_OVERRIDES as FILE_CLASS_SLOT_OVERRIDES,
    TERMS_OF_SERVICE as FILE_TERMS_OF_SERVICE,
} from "../../../../../prisma/seed-data";

export const dynamic = "force-dynamic";

export async function POST() {
    // 원장 권한이 있는 사용자만 시드 데이터를 복원할 수 있다.
    try {
        await requireOwner();
    } catch {
        return NextResponse.json({ error: "원장 권한이 필요합니다." }, { status: 403 });
    }

    // 1) Storage 의 최신 자동 스냅샷을 먼저 읽는다. 예외를 던지지 않는다 — 실패하면 이유 코드만 온다.
    const loaded = await loadLatestSeedSnapshot(() => createAdminClient().storage.from("backups"));
    if (!loaded.ok) console.error("[seed] snapshot not used:", loaded.reason);

    // 2) 못 쓰면 저장소에 든 seed-data.ts 로 넘어간다.
    const PROGRAMS = loaded.ok ? loaded.snapshot.programs : FILE_PROGRAMS;
    const CLASS_SLOT_OVERRIDES = loaded.ok ? loaded.snapshot.classSlotOverrides : FILE_CLASS_SLOT_OVERRIDES;
    const TERMS_OF_SERVICE = loaded.ok ? loaded.snapshot.termsOfService : FILE_TERMS_OF_SERVICE;
    const sourceLabel = loaded.ok ? "자동 스냅샷" : "seed-data.ts";

    const results: Record<string, string> = {};

    // Restore Programs
    let programsRestored = 0;
    if (PROGRAMS.length > 0) {
        let restored = 0;
        for (const p of PROGRAMS) {
            try {
                // frequency·weeklyFrequency·imageUrl·runsShuttle·deletedAt 은 «새로 넣는 줄»에만 쓴다.
                // ON CONFLICT 쪽에는 일부러 넣지 않는다 — 이미 있는 줄의 숨김·셔틀 운행 값은 건드리지 않는다.
                // 이 칸들이 없으면 지워진 표를 복구할 때 숨긴 프로그램이 되살아나고 셔틀 운행이 기본 true 로 돌아간다.
                await prisma.$executeRawUnsafe(
                    `INSERT INTO "Program" (
                        id, name, "targetAge", description, days,
                        "priceWeek1", "priceWeek2", "priceWeek3", "priceDaily",
                        "shuttleFeeOverride", "order", price,
                        frequency, "weeklyFrequency", "imageUrl", "runsShuttle", "deletedAt",
                        "createdAt", "updatedAt"
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::timestamp,NOW(),NOW())
                    ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name,
                        "targetAge" = EXCLUDED."targetAge",
                        description = EXCLUDED.description,
                        days = EXCLUDED.days,
                        "priceWeek1" = EXCLUDED."priceWeek1",
                        "priceWeek2" = EXCLUDED."priceWeek2",
                        "priceWeek3" = EXCLUDED."priceWeek3",
                        "priceDaily" = EXCLUDED."priceDaily",
                        "shuttleFeeOverride" = EXCLUDED."shuttleFeeOverride",
                        "order" = EXCLUDED."order",
                        "updatedAt" = NOW()`,
                    p.id,
                    p.name,
                    p.targetAge,
                    p.description,
                    p.days,
                    p.priceWeek1,
                    p.priceWeek2,
                    p.priceWeek3,
                    p.priceDaily,
                    p.shuttleFeeOverride,
                    p.order,
                    p.priceWeek1 ?? p.priceWeek2 ?? p.priceWeek3 ?? 0, // price fallback
                    p.frequency ?? null,
                    p.weeklyFrequency ?? null,
                    p.imageUrl ?? null,
                    p.runsShuttle ?? true, // 없으면 DB 기본값과 같은 true
                    p.deletedAt ?? null,
                );
                restored++;
            } catch (e) {
                console.error(`[seed] Program "${p.name}" failed:`, e);
            }
        }
        programsRestored = restored;
        results.programs = `${restored}/${PROGRAMS.length}개 복원됨`;
    } else {
        results.programs = `${sourceLabel}에 프로그램 데이터가 없습니다.`;
    }

    // Restore ClassSlotOverrides
    if (CLASS_SLOT_OVERRIDES.length > 0) {
        let restored = 0;
        for (const s of CLASS_SLOT_OVERRIDES) {
            try {
                await prisma.$executeRawUnsafe(
                    `INSERT INTO "ClassSlotOverride" (
                        id, "slotKey", label, note, "isHidden", capacity,
                        "startTimeOverride", "endTimeOverride",
                        "coachId", "programId", "createdAt", "updatedAt"
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
                    ON CONFLICT ("slotKey") DO UPDATE SET
                        label = EXCLUDED.label,
                        note = EXCLUDED.note,
                        "isHidden" = EXCLUDED."isHidden",
                        capacity = EXCLUDED.capacity,
                        "startTimeOverride" = EXCLUDED."startTimeOverride",
                        "endTimeOverride" = EXCLUDED."endTimeOverride",
                        "coachId" = EXCLUDED."coachId",
                        "programId" = EXCLUDED."programId",
                        "updatedAt" = NOW()`,
                    s.id, s.slotKey, s.label, s.note,
                    s.isHidden ?? false, s.capacity ?? 12,
                    s.startTimeOverride ?? null, s.endTimeOverride ?? null,
                    s.coachId ?? null, s.programId ?? null,
                );
                restored++;
            } catch (e) {
                console.error(`[seed] Slot "${s.slotKey}" failed:`, e);
            }
        }
        results.classSlotOverrides = `${restored}/${CLASS_SLOT_OVERRIDES.length}개 복원됨`;
    } else {
        results.classSlotOverrides = `${sourceLabel}에 수업 시간표 데이터가 없습니다.`;
    }

    // Restore Terms of Service
    if (typeof TERMS_OF_SERVICE === "string" && TERMS_OF_SERVICE.length > 0) {
        try {
            await prisma.$executeRawUnsafe(
                `INSERT INTO "AcademySettings" (id, "termsOfService", "createdAt", "updatedAt")
                 VALUES ('singleton', $1, NOW(), NOW())
                 ON CONFLICT (id) DO UPDATE SET
                     "termsOfService" = EXCLUDED."termsOfService",
                     "updatedAt" = NOW()`,
                TERMS_OF_SERVICE,
            );
            results.termsOfService = "이용약관 복원됨";
        } catch (e) {
            console.error("[seed] termsOfService failed:", e);
            results.termsOfService = `실패: ${e}`;
        }
    } else {
        results.termsOfService = `${sourceLabel}에 이용약관 데이터가 없습니다.`;
    }

    // 프로그램을 하나도 복원하지 못했으면 성공으로 답하지 않는다
    // (자동 스냅샷도 없고 seed-data.ts 도 비었거나, 넣기가 전부 실패한 경우).
    const restoredAny = programsRestored > 0;
    return NextResponse.json({
        success: restoredAny,
        ...(restoredAny ? {} : {
            error: PROGRAMS.length === 0
                ? "복원할 프로그램 자료가 없습니다. 자동 스냅샷과 seed-data.ts 가 모두 비어 있습니다."
                : "프로그램을 하나도 복원하지 못했습니다.",
            reason: PROGRAMS.length === 0 ? "NO_SEED_DATA" : "PROGRAM_RESTORE_FAILED",
        }),
        results,
        // 어느 자료로 복구했는지 — storage-snapshot(자동 스냅샷) 또는 seed-data.ts(저장소 파일)
        source: loaded.ok ? "storage-snapshot" : "seed-data.ts",
        seedFile: loaded.ok ? `backups/${SEED_LATEST_PATH}` : "prisma/seed-data.ts",
        // 스냅샷을 만든 시각과 그 날짜(KST). seed-data.ts 로 넘어갔으면 null.
        snapshotExportedAt: loaded.ok ? loaded.snapshot._meta.exportedAt : null,
        snapshotDate: loaded.ok ? toKstYmd(loaded.snapshot._meta.exportedAt) : null,
        // 스냅샷을 못 쓴 이유(코드). 썼으면 null.
        fallbackReason: loaded.ok ? null : loaded.reason,
    }, { status: restoredAny ? 200 : 500 });
}
