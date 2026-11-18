import type { SheetClassSlot } from "@/lib/googleSheetsSchedule";
import { DAY_KEY_TO_LABEL } from "@/lib/googleSheetsSchedule";
import { prisma } from "@/lib/prisma";

// SCHEDULE_SLOT = 사이트 DB 시간표, EMPTY = DB 시간표를 못 읽어 수업 칸 없이(직접 추가한 수업·칸 설정만) 보여 준다.
// (옛 SHEET_CACHE — 구글시트 사본으로 넘어가던 대체 경로 — 는 2026-11-18 삭제)
export type SchedulePayloadSource = "SCHEDULE_SLOT" | "EMPTY";

type CoachPayload = {
    id: string;
    name: string;
    role: string;
    imageUrl: string | null;
    description: string | null;
    order: number;
    createdAt: Date;
    updatedAt: Date;
    slots: [];
    customSlots: [];
};

export type DbScheduleAdminData = {
    slots: SheetClassSlot[];
    overrides: any[];
    customSlots: any[];
    scheduleSource: SchedulePayloadSource;
};

function readJsonArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    if (typeof value !== "string" || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
        return [];
    }
}

function normalizeBool(value: unknown): boolean {
    return value === true || value === "true";
}

function buildCoach(row: any): CoachPayload | null {
    if (!row.c_id) return null;
    return {
        id: row.c_id,
        name: row.c_name,
        role: row.c_role,
        imageUrl: row.c_imageurl ?? null,
        description: row.c_desc ?? null,
        order: Number(row.c_order ?? 0),
        createdAt: new Date(),
        updatedAt: new Date(),
        slots: [],
        customSlots: [],
    };
}

function getSlotLabel(row: any): string | null {
    return row.dayLabel ?? row.daylabel ?? DAY_KEY_TO_LABEL[row.dayKey ?? row.daykey] ?? null;
}

function activeEnrollmentCount(row: any): number {
    return Number(row.active_enrolled ?? row.activeEnrolled ?? row.enrolledSnapshot ?? row.enrolledsnapshot ?? 0);
}

export async function getScheduleSlotAdminData(): Promise<DbScheduleAdminData | null> {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(`
            SELECT
                ss.id, ss."slotKey", ss.source, ss.period, ss."dayKey", ss."dayLabel",
                ss."isWeekend", ss."startTime", ss."endTime", ss.label, ss."gradeRange",
                ss."gradesJSON", ss."enrolledSnapshot", ss.capacity, ss.note, ss."isHidden",
                ss."displayOrder", ss."coachId", ss."programId", ss."createdAt", ss."updatedAt",
                co.id AS c_id, co.name AS c_name, co.role AS c_role,
                co."imageUrl" AS c_imageurl, co.description AS c_desc, co."order" AS c_order,
                COALESCE(ec.active_enrolled, 0)::int AS active_enrolled
            FROM "ScheduleSlot" ss
            LEFT JOIN "Coach" co ON co.id = ss."coachId"
            LEFT JOIN (
                SELECT c."slotKey", COUNT(e.id)::int AS active_enrolled
                FROM "Class" c
                LEFT JOIN "Enrollment" e ON e."classId" = c.id AND e.status = 'ACTIVE'
                WHERE c."slotKey" IS NOT NULL
                GROUP BY c."slotKey"
            ) ec ON ec."slotKey" = ss."slotKey"
            WHERE (ss."activeFrom" IS NULL OR ss."activeFrom" <= NOW())
              AND (ss."activeTo" IS NULL OR ss."activeTo" >= NOW())
            ORDER BY
                CASE ss."dayKey"
                    WHEN 'Mon' THEN 1
                    WHEN 'Tue' THEN 2
                    WHEN 'Wed' THEN 3
                    WHEN 'Thu' THEN 4
                    WHEN 'Fri' THEN 5
                    WHEN 'Sat' THEN 6
                    WHEN 'Sun' THEN 7
                    ELSE 99
                END,
                ss."displayOrder" ASC,
                ss."startTime" ASC
        `);

        if (rows.length === 0) return null;

        const slots: SheetClassSlot[] = [];
        const overrides: any[] = [];
        const customSlots: any[] = [];

        for (const row of rows) {
            const slotKey = row.slotKey ?? row.slotkey;
            const source = row.source ?? "DB";
            const dayKey = row.dayKey ?? row.daykey;
            const dayLabel = getSlotLabel(row) ?? dayKey;
            const startTime = row.startTime ?? row.starttime;
            const endTime = row.endTime ?? row.endtime;
            const capacity = Number(row.capacity ?? 12);
            const enrolled = activeEnrollmentCount(row);
            const isHidden = normalizeBool(row.isHidden ?? row.ishidden);
            const coach = buildCoach(row);

            if (source === "CUSTOM_SLOT") {
                customSlots.push({
                    id: typeof slotKey === "string" && slotKey.startsWith("custom-") ? slotKey.slice("custom-".length) : row.id,
                    dayKey,
                    startTime,
                    endTime,
                    label: row.label ?? "",
                    gradeRange: row.gradeRange ?? row.graderange ?? null,
                    enrolled,
                    capacity,
                    note: row.note ?? null,
                    isHidden,
                    coachId: row.coachId ?? row.coachid ?? null,
                    programId: row.programId ?? row.programid ?? null,
                    createdAt: row.createdAt ?? row.createdat,
                    updatedAt: row.updatedAt ?? row.updatedat,
                    coach,
                    program: null,
                });
                continue;
            }

            slots.push({
                slotKey,
                period: Number(row.period ?? 0),
                dayKey,
                dayLabel,
                isWeekend: normalizeBool(row.isWeekend ?? row.isweekend),
                startTime,
                endTime,
                gradeRange: row.gradeRange ?? row.graderange ?? "",
                grades: readJsonArray(row.gradesJSON ?? row.gradesjson),
                enrolled,
            });

            overrides.push({
                id: row.id,
                slotKey,
                label: row.label ?? null,
                note: row.note ?? null,
                isHidden,
                capacity,
                coachId: row.coachId ?? row.coachid ?? null,
                startTimeOverride: null,
                endTimeOverride: null,
                programId: row.programId ?? row.programid ?? null,
                createdAt: row.createdAt ?? row.createdat,
                updatedAt: row.updatedAt ?? row.updatedat,
                coach,
            });
        }

        return { slots, overrides, customSlots, scheduleSource: "SCHEDULE_SLOT" };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("ScheduleSlot")) {
            console.warn("[getScheduleSlotAdminData] failed:", message);
        }
        return null;
    }
}
