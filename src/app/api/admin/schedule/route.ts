import { createAdminTiming, requireTimedAdmin, timedJson } from "@/lib/adminTiming";
import {
    getClassSlotOverrides,
    getCoaches,
    getCustomClassSlots,
    getPrograms,
} from "@/lib/queries";
import { getScheduleSlotAdminData } from "@/lib/scheduleSlotPayload";

const SCHEDULE_CACHE_HEADERS = {
    "Cache-Control": "private, max-age=30, stale-while-revalidate=120",
};

export async function GET() {
    const timing = createAdminTiming("admin-schedule");

    try {
        await requireTimedAdmin(timing);
    } catch {
        return timedJson(timing, { error: "Authentication required" }, { status: 401 });
    }

    try {
        const [dbScheduleData, coaches, programs] = await timing.measure("primary-data", () => Promise.all([
            getScheduleSlotAdminData(),
            getCoaches(),
            getPrograms(),
        ]));

        let scheduleData = dbScheduleData;
        if (!scheduleData) {
            // DB 시간표(ScheduleSlot)를 못 읽으면 수업 칸 없이 칸 설정·직접 추가한 수업만 돌려준다
            // (구글시트 사본 대체 경로는 2026-11-18 삭제).
            const [overrides, customSlots] = await timing.measure("fallback-data", () => Promise.all([
                getClassSlotOverrides(),
                getCustomClassSlots(),
            ]));
            scheduleData = {
                slots: [],
                overrides,
                customSlots,
                scheduleSource: "EMPTY" as const,
            };
        }

        return timedJson(
            timing,
            {
                slots: scheduleData.slots,
                overrides: scheduleData.overrides,
                coaches,
                customSlots: scheduleData.customSlots,
                programs,
                scheduleSource: scheduleData.scheduleSource,
            },
            { headers: SCHEDULE_CACHE_HEADERS },
        );
    } catch (error) {
        console.error("[api/admin/schedule] failed:", error);
        return timedJson(timing, { error: "Failed to load schedule data" }, { status: 500 });
    }
}
