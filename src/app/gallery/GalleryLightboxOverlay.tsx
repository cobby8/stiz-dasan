"use client";

import { useCallback, useEffect } from "react";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import { type GalleryLightboxItem } from "./GalleryLightboxController";
import { formatKstDate } from "@/lib/datetime/kst";

export default function GalleryLightboxOverlay({
    items,
    activeIndex,
    onClose,
    onNavigate,
}: {
    items: GalleryLightboxItem[];
    activeIndex: number;
    onClose: () => void;
    onNavigate: (index: number) => void;
}) {
    const item = items[activeIndex];

    const goPrev = useCallback(() => {
        if (activeIndex > 0) onNavigate(activeIndex - 1);
    }, [activeIndex, onNavigate]);

    const goNext = useCallback(() => {
        if (activeIndex < items.length - 1) onNavigate(activeIndex + 1);
    }, [activeIndex, items.length, onNavigate]);

    const handleKeyDown = useCallback(
        (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
            if (event.key === "ArrowLeft") goPrev();
            if (event.key === "ArrowRight") goNext();
        },
        [goNext, goPrev, onClose]
    );

    useEffect(() => {
        document.addEventListener("keydown", handleKeyDown);
        document.body.style.overflow = "hidden";

        return () => {
            document.removeEventListener("keydown", handleKeyDown);
            document.body.style.overflow = "";
        };
    }, [handleKeyDown]);

    if (!item) return null;

    return (
        <div
            className="public-gallery-lightbox fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/95 px-3 py-16"
            role="dialog"
            aria-modal="true"
            onClick={onClose}
            aria-label="갤러리 라이트박스"
        >
            {/* 닫기 버튼 */}
            <button
                type="button"
                onClick={onClose}
                className="fixed top-[max(12px,env(safe-area-inset-top))] right-[max(12px,env(safe-area-inset-right))] z-20 flex h-12 w-12 items-center justify-center rounded-full bg-black/70 text-white hover:bg-white/10 transition-colors"
                aria-label="닫기"
            >
                <FontFreeIcon name="close" size={28} />
            </button>

            {/* 카운터 — 현재 위치 / 전체 개수 */}
            <div className="fixed top-[max(24px,env(safe-area-inset-top))] left-1/2 -translate-x-1/2 text-white/80 text-sm z-10">
                {activeIndex + 1} / {items.length}
            </div>

            {/* 이전 버튼 */}
            {activeIndex > 0 && (
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        goPrev();
                    }}
                    className="absolute left-2 md:left-6 text-white/40 hover:bg-white/10 hover:text-white z-10 p-2 rounded-full transition-colors"
                    aria-label="이전 사진"
                >
                    <FontFreeIcon name="chevron_left" size={36} />
                </button>
            )}

            {/* 다음 버튼 */}
            {activeIndex < items.length - 1 && (
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        goNext();
                    }}
                    className="absolute right-2 md:right-6 text-white/40 hover:bg-white/10 hover:text-white z-10 p-2 rounded-full transition-colors"
                    aria-label="다음 사진"
                >
                    <FontFreeIcon name="chevron_right" size={36} />
                </button>
            )}

            {/* 미디어 콘텐츠 영역 */}
            <div className="my-auto flex min-w-0 max-w-5xl flex-col items-center" onClick={(event) => event.stopPropagation()}>
                {item.type === "image" ? (
                    <img
                        src={item.url}
                        alt={item.title || "갤러리 이미지"}
                        className="max-w-full max-h-[65dvh] object-contain rounded-lg"
                    />
                ) : (
                    <video
                        src={item.url}
                        controls
                        autoPlay
                        className="max-w-full max-h-[65dvh] rounded-lg"
                    />
                )}

                {/* 제목/설명/날짜 — 미디어 아래에 표시 */}
                {(item.title || item.caption) && (
                    <div className="mt-3 max-w-lg break-words text-center">
                        {item.title && (
                            <p className="text-white font-bold text-lg">{item.title}</p>
                        )}
                        {item.caption && (
                            <p className="text-white/60 text-sm mt-1 leading-relaxed">{item.caption}</p>
                        )}
                        <p className="text-white/30 text-xs mt-3">
                            {formatKstDate(item.createdAt, {
                                year: "numeric",
                                month: "long",
                                day: "numeric",
                            })}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
