// 구글 시트 CSV 요청 — 시간 제한(5초) + 연결 끊김 때 1회 재시도(2026-11-14). 실패 시 기존대로 빈 목록
import { fetchWithRetry } from "@/lib/net/resilience";
/**
 * 구글시트 "통합시간표" 탭 파싱 모듈
 *
 * 시트 구조:
 *   Col A : n교시 (병합셀 → CSV에서 블록 첫 행에만 값)
 *   Col B : 학년명(6세·7세·초1~초6·중1~중3·고1~고3·성인) 또는 "합계"
 *   Col C~I : 월요일~일요일 수강생 수 (숫자)
 *   Col J : 주말 비고 (시간 메모용 — 파싱하지 않음)
 *
 * 시간 매핑 (사용자 정의):
 *   평일 0~5교시 : 0교시=12:00, 60분 배정, 55분 수업
 *   평일 6~8교시 : 6교시=18:00, 80분 배정, 75분 수업
 *   주말 0~n교시 : 0교시=08:30, 70분 배정, 65분 수업
 */

export const GRADE_ORDER = [
    "6세", "7세",
    "초1", "초2", "초3", "초4", "초5", "초6",
    "중1", "중2", "중3",
    "고1", "고2", "고3",
    "성인",
] as const;

export type Grade = (typeof GRADE_ORDER)[number];

export interface SheetClassSlot {
    /** "{dayKey}-{period}"  e.g. "Mon-4" */
    slotKey: string;
    period: number;
    dayKey: string;    // "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun"
    dayLabel: string;  // "월요일" etc.
    isWeekend: boolean;
    startTime: string; // "16:00"
    endTime: string;   // "16:55"
    gradeRange: string;// "초4~중1"
    grades: string[];  // grades with count > 0, sorted
    enrolled: number;
}

// ─── Day column config ───────────────────────────────────────────────────────
const DAY_COLUMNS = [
    { colIndex: 2, key: "Mon", label: "월요일", isWeekend: false },
    { colIndex: 3, key: "Tue", label: "화요일", isWeekend: false },
    { colIndex: 4, key: "Wed", label: "수요일", isWeekend: false },
    { colIndex: 5, key: "Thu", label: "목요일", isWeekend: false },
    { colIndex: 6, key: "Fri", label: "금요일", isWeekend: false },
    { colIndex: 7, key: "Sat", label: "토요일", isWeekend: true  },
    { colIndex: 8, key: "Sun", label: "일요일", isWeekend: true  },
] as const;

export const DAY_KEY_TO_LABEL: Record<string, string> = Object.fromEntries(
    DAY_COLUMNS.map((d) => [d.key, d.label])
);

// ─── Time calculation ────────────────────────────────────────────────────────
function pad(n: number) { return String(n).padStart(2, "0"); }
function minsToTime(m: number) { return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }

// 평일 6~8교시 시작 분 (절대값)
const EVENING_START: Record<number, number> = {
    6: 18 * 60,
    7: 19 * 60 + 20,
    8: 20 * 60 + 40,
};

export function getSlotTime(period: number, isWeekend: boolean): { start: string; end: string } {
    if (isWeekend) {
        // 주말: 0교시=08:30, 70분 배정, 65분 수업
        const start = 8 * 60 + 30 + period * 70;
        return { start: minsToTime(start), end: minsToTime(start + 65) };
    }
    if (period <= 5) {
        // 평일 0~5교시: 0교시=12:00, 60분 배정, 55분 수업
        const start = 12 * 60 + period * 60;
        return { start: minsToTime(start), end: minsToTime(start + 55) };
    }
    // 평일 6~8교시: 80분 배정, 75분 수업
    const start = EVENING_START[period] ?? 18 * 60;
    return { start: minsToTime(start), end: minsToTime(start + 75) };
}

// ─── Grade range formatting ───────────────────────────────────────────────────
export function formatGradeRange(grades: string[]): string {
    const sorted = [...new Set(grades)]
        .filter((g): g is Grade => GRADE_ORDER.includes(g as Grade))
        .sort((a, b) => GRADE_ORDER.indexOf(a) - GRADE_ORDER.indexOf(b));
    if (sorted.length === 0) return "";
    if (sorted.length === 1) return sorted[0];
    return `${sorted[0]}~${sorted[sorted.length - 1]}`;
}

// ─── CSV line parser (handles quoted commas) ─────────────────────────────────
function parseCSVLine(line: string): string[] {
    const cells: string[] = [];
    let inQuotes = false;
    let cell = "";
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') { cell += '"'; i++; }
            else inQuotes = !inQuotes;
        } else if (ch === "," && !inQuotes) {
            cells.push(cell.trim());
            cell = "";
        } else {
            cell += ch;
        }
    }
    cells.push(cell.trim());
    return cells;
}

// ─── Main CSV → slots parser ─────────────────────────────────────────────────
export function parseSheetCSV(csvText: string): SheetClassSlot[] {
    const rows = csvText.split(/\r?\n/).map(parseCSVLine);
    const slots: SheetClassSlot[] = [];

    let period: number | null = null;

    // Per-period accumulator (reset each period block)
    const gradesByDay: Record<string, string[]> = {};
    const totalByDay: Record<string, number> = {};

    function resetDayData() {
        for (const d of DAY_COLUMNS) {
            gradesByDay[d.key] = [];
            totalByDay[d.key] = 0;
        }
    }

    function flushPeriod() {
        if (period === null) return;
        for (const d of DAY_COLUMNS) {
            const total = totalByDay[d.key] ?? 0;
            if (total <= 0) continue;
            const grades = gradesByDay[d.key] ?? [];
            const { start, end } = getSlotTime(period, d.isWeekend);
            slots.push({
                slotKey: `${d.key}-${period}`,
                period,
                dayKey: d.key,
                dayLabel: d.label,
                isWeekend: d.isWeekend,
                startTime: start,
                endTime: end,
                gradeRange: formatGradeRange(grades),
                grades: [...grades].sort(
                    (a, b) => GRADE_ORDER.indexOf(a as Grade) - GRADE_ORDER.indexOf(b as Grade)
                ),
                enrolled: total,
            });
        }
    }

    resetDayData();

    for (const row of rows) {
        const colA = (row[0] ?? "").trim();
        const colB = (row[1] ?? "").trim();

        // New period block detected (col A = "n교시")
        const periodMatch = colA.match(/^(\d+)교시$/);
        if (periodMatch) {
            flushPeriod();
            period = parseInt(periodMatch[1], 10);
            resetDayData();
            // Fall through — this row might also have B="합계" or a grade
        }

        if (period === null) continue;

        if (colB === "합계") {
            // Always overwrite — LAST 합계 row seen per block = current enrollment
            for (const d of DAY_COLUMNS) {
                const val = parseInt(row[d.colIndex] ?? "0", 10) || 0;
                totalByDay[d.key] = val;
            }
        } else if (GRADE_ORDER.includes(colB as Grade)) {
            for (const d of DAY_COLUMNS) {
                const val = parseInt(row[d.colIndex] ?? "0", 10) || 0;
                if (val > 0) gradesByDay[d.key].push(colB);
            }
        }
    }

    flushPeriod();
    return slots;
}

// ─── HTTP fetch wrapper ───────────────────────────────────────────────────────
function extractCsvUrl(sheetUrl: string): string | null {
    const idMatch = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!idMatch) return null;
    const id = idMatch[1];
    const gidMatch = sheetUrl.match(/[?&#]gid=(\d+)/);
    const gid = gidMatch?.[1];
    return gid
        ? `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`
        : `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
}

/** 공개 페이지용: Next.js HTTP 캐시 5분 */
export async function fetchSheetSchedule(sheetUrl: string): Promise<SheetClassSlot[]> {
    const csvUrl = extractCsvUrl(sheetUrl);
    if (!csvUrl) return [];
    try {
        const res = await fetchWithRetry(csvUrl, { next: { revalidate: 300 } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseSheetCSV(await res.text());
    } catch (e) {
        console.error("[fetchSheetSchedule]", e);
        return [];
    }
}

/** 동기화 전용: 캐시 없이 항상 최신 데이터를 가져옴 (cron/sync-schedule에서 사용) */
export async function fetchSheetScheduleNoCache(sheetUrl: string): Promise<SheetClassSlot[]> {
    const csvUrl = extractCsvUrl(sheetUrl);
    if (!csvUrl) return [];
    try {
        const res = await fetchWithRetry(csvUrl, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseSheetCSV(await res.text());
    } catch (e) {
        console.error("[fetchSheetScheduleNoCache]", e);
        return [];
    }
}

/** 관리자 페이지용: 30초 캐시 (수정 후 revalidatePath 로 즉시 무효화됨) */
export async function fetchSheetScheduleAdmin(sheetUrl: string): Promise<SheetClassSlot[]> {
    const csvUrl = extractCsvUrl(sheetUrl);
    if (!csvUrl) return [];
    try {
        const res = await fetchWithRetry(csvUrl, { next: { revalidate: 30 } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseSheetCSV(await res.text());
    } catch (e) {
        console.error("[fetchSheetScheduleAdmin]", e);
        return [];
    }
}
