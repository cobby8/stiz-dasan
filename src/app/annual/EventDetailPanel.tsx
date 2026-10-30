"use client";

import { useEffect } from "react";
import { SerializedEvent } from "./AnnualEventsClient";

const CATEGORY_STYLES: Record<string, { bg: string; text: string; dot: string; border: string }> = {
    대회: { bg: "bg-orange-50", text: "text-orange-700", dot: "bg-orange-500", border: "border-orange-200" },
    방학: { bg: "bg-red-50", text: "text-red-700", dot: "bg-red-500", border: "border-red-200" },
    특별행사: { bg: "bg-amber-50", text: "text-amber-800", dot: "bg-amber-500", border: "border-amber-200" },
    정기행사: { bg: "bg-blue-50", text: "text-blue-700", dot: "bg-blue-500", border: "border-blue-200" },
    일반: { bg: "bg-green-50", text: "text-green-700", dot: "bg-green-500", border: "border-green-200" },
};

function formatDate(isoString: string, isAllDay: boolean): string {
    const d = new Date(isoString);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
    const dow = weekdays[d.getDay()];
    if (isAllDay) return `${month}월 ${day}일 (${dow})`;
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    return `${month}월 ${day}일 (${dow}) ${hh}:${mm}`;
}

interface Props {
    event: SerializedEvent | null;
    onClose: () => void;
}

export default function EventDetailPanel({ event, onClose }: Props) {
    // ESC 키로 닫기
    useEffect(() => {
        if (!event) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, [event, onClose]);

    // 패널 열릴 때 body 스크롤 잠금
    useEffect(() => {
        if (event) {
            document.body.style.overflow = "hidden";
        } else {
            document.body.style.overflow = "";
        }
        return () => { document.body.style.overflow = ""; };
    }, [event]);

    if (!event) return null;

    const catStyle = CATEGORY_STYLES[event.category] || CATEGORY_STYLES["일반"];
    const isMultiDay = !!event.endDate;

    return (
        <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
            role="dialog"
            aria-modal="true"
            aria-label={event.title}
        >
            {/* 배경 오버레이 */}
            <div
                className="absolute inset-0 bg-black/50 animate-fade-in"
                onClick={onClose}
                aria-hidden="true"
            />

            {/* 패널 본체 — 모바일: 하단 슬라이드업, 데스크톱: 중앙 모달 */}
            <div className="relative bg-white dark:bg-gray-800 w-full sm:max-w-lg sm:mx-4 sm:rounded-2xl rounded-t-2xl shadow-2xl max-h-[85vh] flex flex-col animate-slide-up">

                {/* 모바일 핸들 바 */}
                <div className="sm:hidden flex justify-center pt-3 pb-1 shrink-0">
                    <div className="w-10 h-1 rounded-full bg-gray-300" />
                </div>

                {/* 헤더 */}
                <div className="flex items-start justify-between px-6 pt-4 pb-4 border-b border-gray-100 dark:border-gray-800 shrink-0">
                    <div className="flex-1 min-w-0 pr-4">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-0.5 rounded-full mb-2 border ${catStyle.bg} ${catStyle.text} ${catStyle.border}`}>
                            <span className={`w-2 h-2 rounded-full ${catStyle.dot}`} />
                            {event.category || "일반"}
                        </span>
                        <h2 className="text-xl font-black text-gray-900 dark:text-white leading-tight break-words">
                            {event.title}
                        </h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition text-lg"
                        aria-label="닫기"
                    >
                        ✕
                    </button>
                </div>

                {/* 내용 */}
                <div className="px-6 py-5 space-y-5 overflow-y-auto">
                    {/* 날짜/시간 */}
                    <div className="flex items-start gap-3">
                        <span className="text-xl mt-0.5">📅</span>
                        <div>
                            <p className="font-bold text-gray-900 dark:text-white text-sm">
                                {formatDate(event.date, event.isAllDay)}
                            </p>
                            {isMultiDay && event.endDate && (
                                <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                                    ~ {formatDate(event.endDate, event.isAllDay)}
                                </p>
                            )}
                            {event.isAllDay && (
                                <span className="mt-1.5 inline-block text-xs text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">
                                    종일
                                </span>
                            )}
                        </div>
                    </div>

                    {/* 설명 */}
                    {event.description ? (
                        <div className="flex items-start gap-3">
                            <span className="text-xl mt-0.5">📝</span>
                            <p className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed whitespace-pre-line">
                                {event.description}
                            </p>
                        </div>
                    ) : (
                        <div className="flex items-start gap-3">
                            <span className="text-xl mt-0.5">📝</span>
                            <p className="text-sm text-gray-400 italic">설명 없음</p>
                        </div>
                    )}

                    {/* 구글 캘린더 원본 링크 */}
                    {event.url && (
                        <div className="pt-1 border-t border-gray-100 dark:border-gray-800">
                            <a
                                href={event.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-2 text-sm font-bold text-blue-600 hover:text-blue-800 hover:underline transition"
                            >
                                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M19 3h-1V1h-2v2H8V1H6v2H5C3.89 3 3 3.9 3 5v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zm0 16H5V8h14v11z"/>
                                </svg>
                                구글 캘린더에서 보기
                            </a>
                        </div>
                    )}
                </div>

                {/* 하단 닫기 버튼 */}
                <div className="px-6 pb-6 pt-2 shrink-0">
                    <button
                        onClick={onClose}
                        className="w-full py-3 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 text-gray-700 dark:text-gray-200 font-bold text-sm transition"
                    >
                        닫기
                    </button>
                </div>
            </div>
        </div>
    );
}
