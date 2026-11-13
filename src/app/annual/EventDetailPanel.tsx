"use client";

import { useEffect } from "react";
import { SerializedEvent } from "./AnnualEventsClient";
import { usePublicOverlayOpen } from "@/components/public-floating";
import { kstDow, kstHm, toKstYmd } from "@/lib/datetime/kst";

const CATEGORY_STYLES: Record<string, { bg: string; text: string; dot: string; border: string }> = {
    대회: { bg: "bg-orange-50", text: "text-orange-700", dot: "bg-orange-500", border: "border-orange-200" },
    방학: { bg: "bg-red-50", text: "text-red-700", dot: "bg-red-500", border: "border-red-200" },
    특별행사: { bg: "bg-amber-50", text: "text-amber-800", dot: "bg-amber-500", border: "border-amber-200" },
    정기행사: { bg: "bg-[var(--color-public-tint)]", text: "text-[var(--color-public-muted)]", dot: "bg-blue-500", border: "border-[var(--color-public-line)]" },
    일반: { bg: "bg-green-50", text: "text-green-700", dot: "bg-green-500", border: "border-green-200" },
};

// 일정 날짜·시각은 기기 시간대가 아니라 KST 달력으로 읽는다(해외 기기·서버 렌더에서도 같은 글자).
export function formatDate(isoString: string, isAllDay: boolean): string {
    const ymd = toKstYmd(isoString); // "YYYY-MM-DD" (KST)
    if (!ymd) return "";
    const [, month, day] = ymd.split("-").map(Number);
    const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
    const dow = weekdays[kstDow(ymd)];
    if (isAllDay) return `${month}월 ${day}일 (${dow})`;
    return `${month}월 ${day}일 (${dow}) ${kstHm(isoString)}`;
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

    // 패널(모바일 하단 시트)이 열린 동안 챗봇·입학 가이드 플로팅 버튼을 숨긴다(게슈탈트 C-P3)
    usePublicOverlayOpen(Boolean(event));

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
            <div className="relative bg-white dark:bg-[var(--color-public-tint)] w-full sm:max-w-lg sm:mx-4 sm:rounded-2xl rounded-t-2xl shadow-2xl max-h-[85vh] flex flex-col animate-slide-up">

                {/* 모바일 핸들 바 */}
                <div className="sm:hidden flex justify-center pt-3 pb-1 shrink-0">
                    <div className="w-10 h-1 rounded-full bg-gray-300" />
                </div>

                {/* 헤더 */}
                <div className="flex items-start justify-between px-6 pt-4 pb-4 border-b border-[var(--color-public-line)] dark:border-[var(--color-public-line)] shrink-0">
                    <div className="flex-1 min-w-0 pr-4">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-0.5 rounded-full mb-2 border ${catStyle.bg} ${catStyle.text} ${catStyle.border}`}>
                            <span className={`w-2 h-2 rounded-full ${catStyle.dot}`} />
                            {event.category || "일반"}
                        </span>
                        <h2 className="text-xl font-black text-[var(--color-public-ink)] dark:text-white leading-tight break-words">
                            {event.title}
                        </h2>
                    </div>
                    {/* 닫기 — 터치 영역 44px(게슈탈트 P-13) */}
                    <button
                        onClick={onClose}
                        className="shrink-0 min-h-11 px-3 flex items-center justify-center rounded-full text-sm font-medium hover:bg-[var(--color-public-tint)] dark:hover:bg-[var(--color-public-tint)] text-[var(--color-public-muted)] hover:text-[var(--color-public-muted)] dark:hover:text-[var(--color-public-ink)] transition"
                        aria-label="닫기"
                    >
                        닫기
                    </button>
                </div>

                {/* 내용 */}
                <div className="px-6 py-5 space-y-5 overflow-y-auto">
                    {/* 날짜/시간 */}
                    <div className="flex items-start gap-3">
                        <div>
                            <p className="font-bold text-[var(--color-public-ink)] dark:text-white text-sm">
                                {formatDate(event.date, event.isAllDay)}
                            </p>
                            {isMultiDay && event.endDate && (
                                <p className="text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)] mt-0.5">
                                    ~ {formatDate(event.endDate, event.isAllDay)}
                                </p>
                            )}
                            {event.isAllDay && (
                                <span className="mt-1.5 inline-block text-xs text-[var(--color-public-muted)] bg-[var(--color-public-tint)] dark:bg-[var(--color-public-tint)] px-2 py-0.5 rounded-full">
                                    종일
                                </span>
                            )}
                        </div>
                    </div>

                    {/* 설명 */}
                    {event.description ? (
                        <div className="flex items-start gap-3">
                            <p className="text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)] leading-relaxed whitespace-pre-line">
                                {event.description}
                            </p>
                        </div>
                    ) : (
                        <div className="flex items-start gap-3">
                            <p className="text-sm text-[var(--color-public-muted)] italic">설명 없음</p>
                        </div>
                    )}

                    {/* 구글 캘린더 원본 링크 */}
                    {event.url && (
                        <div className="pt-1 border-t border-[var(--color-public-line)] dark:border-[var(--color-public-line)]">
                            <a
                                href={event.url} data-outside-link
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-2 text-sm font-bold text-[var(--color-public-muted)] hover:text-[var(--color-public-ink)] hover:underline transition"
                            >
                                구글 캘린더에서 보기
                            </a>
                        </div>
                    )}
                </div>

                {/* 하단 닫기 버튼 */}
                <div className="px-6 pb-6 pt-2 shrink-0">
                    <button
                        onClick={onClose}
                        className="w-full py-3 rounded-xl bg-[var(--color-public-tint)] dark:bg-[var(--color-public-tint)] hover:bg-[var(--color-public-line)] text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)] font-bold text-sm transition"
                    >
                        닫기
                    </button>
                </div>
            </div>
        </div>
    );
}
