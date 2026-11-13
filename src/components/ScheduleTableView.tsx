"use client";

import type { PublicScheduleSlot } from "@/app/schedule/ScheduleClient";
// 잔여 인원 3단계(여유/임박/마감) — 숫자 없이(재원생 수 비공개 · 2026-11-13 f9). 기준·색은 한 곳
import { SEAT_LEVEL_DOT_CLASS, SEAT_LEVEL_LABEL, SEAT_LEVEL_TEXT_CLASS } from "@/lib/seats/seatLevel";

// 요일 순서 및 한글 라벨
const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAY_LABEL: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목",
    Fri: "금", Sat: "토", Sun: "일",
};

// 요일 헤더 배경색 — 기존 카드뷰와 톤 통일
const DAY_HEADER_BG: Record<string, string> = {
    Mon: "bg-blue-600", Tue: "bg-green-600", Wed: "bg-yellow-500",
    Thu: "bg-purple-600", Fri: "bg-red-500", Sat: "bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900",
    Sun: "bg-gray-500",
};

export default function ScheduleTableView({ slots }: { slots: PublicScheduleSlot[] }) {
    // 1) 시간대 추출 — startTime 기준 고유값을 정렬
    const timeSet = new Set<string>();
    slots.forEach((s) => timeSet.add(s.startTime));
    const times = Array.from(timeSet).sort();

    // 2) 활성 요일만 추출 — 데이터가 있는 요일만 표시
    const activeDays = DAY_ORDER.filter((d) =>
        slots.some((s) => s.dayKey === d)
    );

    // 3) (요일, 시간) -> 슬롯 배열 매핑 (같은 시간대에 여러 수업 가능)
    const grid: Record<string, Record<string, PublicScheduleSlot[]>> = {};
    for (const day of activeDays) {
        grid[day] = {};
        for (const time of times) {
            grid[day][time] = slots.filter(
                (s) => s.dayKey === day && s.startTime === time
            );
        }
    }

    // 데이터가 없으면 표시하지 않음
    if (times.length === 0 || activeDays.length === 0) {
        return (
            <div className="text-center py-12 text-gray-400">
                <p className="text-lg font-bold text-gray-500 dark:text-gray-400">표시할 시간표가 없습니다.</p>
            </div>
        );
    }

    return (
        // 모바일에서 가로 스크롤 가능하도록 overflow-x-auto 적용
        <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm bg-white dark:bg-gray-800">
            <table className="w-full min-w-[640px] border-collapse">
                {/* 테이블 헤더 — 요일별 컬럼 */}
                <thead>
                    <tr>
                        {/* 좌측 상단: 시간 라벨 */}
                        <th className="sticky left-0 z-10 bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-xs font-bold px-3 py-3 border-b border-r border-gray-200 dark:border-gray-700 w-[80px] text-center">
                            시간
                        </th>
                        {activeDays.map((day) => (
                            <th
                                key={day}
                                className={`${DAY_HEADER_BG[day]} text-white text-sm font-black px-3 py-3 border-b border-gray-200 dark:border-gray-700 text-center min-w-[140px]`}
                            >
                                {DAY_LABEL[day]}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {times.map((time) => (
                        <tr key={time} className="border-b border-gray-100 dark:border-gray-800 last:border-b-0">
                            {/* 시간대 셀 — 고정 컬럼 */}
                            <td className="sticky left-0 z-10 bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-200 text-sm font-bold px-3 py-3 border-r border-gray-200 dark:border-gray-700 text-center whitespace-nowrap">
                                {time}
                            </td>
                            {activeDays.map((day) => {
                                const cellSlots = grid[day][time];
                                // 빈 셀 — 회색 배경에 대시 표시
                                if (!cellSlots || cellSlots.length === 0) {
                                    return (
                                        <td
                                            key={`${day}-${time}`}
                                            className="bg-gray-50 dark:bg-gray-900/50 text-gray-300 text-center px-2 py-3 border-r border-gray-100 dark:border-gray-800 last:border-r-0"
                                        >
                                            —
                                        </td>
                                    );
                                }
                                // 슬롯이 있는 셀
                                return (
                                    <td
                                        key={`${day}-${time}`}
                                        className="px-2 py-2 border-r border-gray-100 dark:border-gray-800 last:border-r-0 align-top"
                                    >
                                        <div className="space-y-1.5">
                                            {cellSlots.map((slot) => {
                                                return (
                                                    <div
                                                        key={slot.slotKey}
                                                        className="rounded-lg border border-gray-100 dark:border-gray-800 p-2.5 bg-white dark:bg-gray-800 shadow-sm hover:shadow-md transition-shadow"
                                                    >
                                                        {/* 학년 대상 */}
                                                        {slot.gradeRange && (
                                                            <p className="text-xs font-bold text-gray-900 dark:text-white mb-1 leading-tight">
                                                                {slot.gradeRange}
                                                            </p>
                                                        )}
                                                        {/* 정원 인디케이터 — 색상 도트로 여유/임박/마감 표시 */}
                                                        <div className="flex items-center gap-1 mb-1">
                                                            <span className={`inline-block w-2 h-2 rounded-full ${SEAT_LEVEL_DOT_CLASS[slot.seatLevel]}`} />
                                                            {/* 글자 최소 12px(컴팩트 규칙) */}
                                                            <span className={`text-[12px] font-bold ${SEAT_LEVEL_TEXT_CLASS[slot.seatLevel]}`}>
                                                                {SEAT_LEVEL_LABEL[slot.seatLevel]}
                                                            </span>
                                                        </div>
                                                        {/* 코치명 — 있을 때만 표시 */}
                                                        {slot.coach && (
                                                            <div className="flex items-center gap-1">
                                                                <span className="material-symbols-outlined text-gray-400" style={{ fontSize: "14px" }}>
                                                                    person
                                                                </span>
                                                                <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                                                                    {slot.coach.name}
                                                                </span>
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
