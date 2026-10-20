"use client";

import { useMemo, useState } from "react";
import GalleryLightboxController, { type GalleryLightboxItem } from "./GalleryLightboxController";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import { isDurableGalleryMediaUrl, parseGalleryMediaJSON } from "@/lib/galleryMedia";

type GalleryPost = {
    id: string;
    title: string | null;
    caption: string | null;
    mediaJSON: string;
    createdAt: Date | string;
    className: string | null;
};

const INITIAL_VISIBLE_ITEMS = 24;
const VISIBLE_ITEM_INCREMENT = 24;

export default function GalleryPublicClient({ posts }: { posts: GalleryPost[] }) {
    const items = useMemo(() => getGalleryItems(posts), [posts]);
    const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ITEMS);
    const visibleItems = items.slice(0, visibleCount);
    const hasMoreItems = visibleCount < items.length;

    // 빈 갤러리 — 아이콘 + 안내 메시지 표시
    if (items.length === 0) {
        return (
            <div className="text-center py-20 text-gray-400">
                <FontFreeIcon name="image" size={64} className="mx-auto mb-4 text-gray-300" />
                <p className="text-lg font-medium">아직 갤러리가 비어있습니다</p>
                <p className="text-sm mt-1">곧 수업 사진이 업로드됩니다.</p>
            </div>
        );
    }

    return (
        <>
            {/* 갤러리 그리드 — 반응형 2/3/4열 */}
            <div data-gallery-root className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4">
                {visibleItems.map((item, index) => (
                    <button
                        key={`${item.postId}-${item.mediaIdx}`}
                        type="button"
                        data-gallery-index={index}
                        className="aspect-square rounded-2xl overflow-hidden bg-gray-100 dark:bg-gray-800 cursor-pointer relative group shadow-sm hover:shadow-lg transition-all duration-300 text-left"
                        aria-label={`${item.title || "갤러리 이미지"} 크게 보기`}
                    >
                        {/* 미디어 — 이미지 또는 동영상 */}
                        {item.type === "image" ? (
                            <img
                                src={item.url}
                                alt={item.title || "갤러리 이미지"}
                                loading={index < 4 ? "eager" : "lazy"}
                                decoding="async"
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                            />
                        ) : (
                            <>
                                <video src={item.url} className="w-full h-full object-cover" muted preload="metadata" />
                                {/* 동영상 재생 아이콘 표시 */}
                                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                    <div className="w-12 h-12 rounded-full bg-black/50 flex items-center justify-center">
                                        <FontFreeIcon name="play_arrow" size={20} className="ml-1 text-white" />
                                    </div>
                                </div>
                            </>
                        )}

                        {/* 호버 오버레이 — 제목 + 날짜 표시 (개선된 그라데이션) */}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/0 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                            <div className="absolute bottom-0 left-0 right-0 p-3 md:p-4">
                                {/* 게시물 제목 — 첫 번째 미디어에만 표시 */}
                                {item.mediaIdx === 0 && item.title && (
                                    <p className="text-white text-sm font-bold truncate mb-1">{item.title}</p>
                                )}
                                {/* 날짜 표시 */}
                                <p className="text-white/70 text-xs flex items-center gap-1">
                                    <FontFreeIcon name="calendar_today" size={10} />
                                    {item.displayDate}
                                </p>
                            </div>
                        </div>

                        {/* 모바일에서는 항상 제목 표시 (호버 불가하므로) */}
                        {item.mediaIdx === 0 && item.title && (
                            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-3 md:hidden">
                                <p className="text-white text-xs font-medium truncate">{item.title}</p>
                            </div>
                        )}
                    </button>
                ))}
            </div>

            {hasMoreItems && (
                <div className="mt-10 flex justify-center">
                    <button
                        type="button"
                        onClick={() => setVisibleCount((current) => Math.min(current + VISIBLE_ITEM_INCREMENT, items.length))}
                        className="min-h-11 rounded-full border border-brand-orange-200 bg-white px-6 text-sm font-black text-brand-orange-600 shadow-sm transition hover:border-brand-orange-500 hover:bg-orange-50 dark:border-gray-700 dark:bg-gray-800 dark:text-brand-neon-lime"
                    >
                        더 보기
                    </button>
                </div>
            )}

            <GalleryLightboxController items={visibleItems} />
        </>
    );
}

function getGalleryItems(posts: GalleryPost[]): GalleryLightboxItem[] {
    const items: GalleryLightboxItem[] = [];

    posts.forEach((post) => {
        const media = parseGalleryMediaJSON(post.mediaJSON);

        media.forEach((item, mediaIdx) => {
            if (!isDurableGalleryMediaUrl(item.url)) return;

            const createdAt = new Date(post.createdAt);
            items.push({
                url: item.url,
                type: item.type === "video" ? "video" : "image",
                title: post.title,
                caption: post.caption,
                postId: post.id,
                mediaIdx,
                createdAt: createdAt.toISOString(),
                displayDate: createdAt.toLocaleDateString("ko-KR"),
            });
        });
    });

    return items;
}
