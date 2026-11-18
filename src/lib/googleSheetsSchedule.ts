/**
 * 시간표 공용 타입·상수 (이름은 옛 그대로 — 예전엔 구글시트 "통합시간표" 탭을 읽어 오는 모듈이었다).
 *
 * 2026-11-18 결정표(sheet-switch «완전히 지운다»): 시트 CSV 읽기·파싱 함수는 지웠다.
 * 시간표 원본은 사이트 DB(ScheduleSlot)다. 여기에는 여러 화면이 같이 쓰는 학년 순서·수업 칸 모양·요일 이름만 남는다.
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

// ─── 요일 이름 ───────────────────────────────────────────────────────────────
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
