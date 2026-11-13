"use client";

import { useMemo, useState } from "react";
import FontFreeIcon from "../ui/FontFreeIcon";

export type InstagramPreviewMediaItem = {
  url: string;
  type: "image" | "video";
};

type InstagramIconName =
  | "bookmark"
  | "chat_bubble"
  | "chevron_left"
  | "chevron_right"
  | "favorite"
  | "more_horiz"
  | "send";

function SymbolIcon({ name, size, className = "" }: { name: InstagramIconName; size: number; className?: string }) {
  return <FontFreeIcon name={name} size={size} className={className} />;
}

export default function InstagramFeedPreview({
  mediaItems,
  caption,
  hashtags,
  editable = false,
  compact = false,
  authorLabel = "stiz_basketball_dasan",
  onCaptionChange,
  onHashtagsChange,
}: {
  mediaItems: InstagramPreviewMediaItem[];
  caption: string;
  hashtags: string;
  editable?: boolean;
  compact?: boolean;
  authorLabel?: string;
  onCaptionChange?: (value: string) => void;
  onHashtagsChange?: (value: string) => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const images = useMemo(() => mediaItems.filter((item) => item.type === "image"), [mediaItems]);
  const active = images[Math.min(activeIndex, Math.max(images.length - 1, 0))];

  function move(delta: number) {
    if (images.length <= 1) return;
    setActiveIndex((index) => (index + delta + images.length) % images.length);
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white text-gray-900 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white">
      <div className="flex h-12 items-center justify-between px-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-orange-500 to-pink-500 text-xs font-semibold text-white">
            S
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{authorLabel}</p>
            <p className="truncate text-xs text-gray-500 dark:text-gray-400">STIZ Basketball Dasan</p>
          </div>
        </div>
        <SymbolIcon name="more_horiz" size={18} className="shrink-0 text-gray-500" />
      </div>

      <div className={`relative bg-gray-100 dark:bg-gray-800 ${compact ? "aspect-square" : "aspect-[4/5]"}`}>
        {active ? (
          <img src={active.url} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gray-400">No image</div>
        )}

        {images.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => move(-1)}
              className="absolute left-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white transition hover:bg-black/60"
              aria-label="이전 사진"
            >
              <SymbolIcon name="chevron_left" size={18} />
            </button>
            <button
              type="button"
              onClick={() => move(1)}
              className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white transition hover:bg-black/60"
              aria-label="다음 사진"
            >
              <SymbolIcon name="chevron_right" size={18} />
            </button>
            <div className="absolute right-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-xs font-medium text-white">
              {Math.min(activeIndex + 1, images.length)} / {images.length}
            </div>
          </>
        )}
      </div>

      <div className="space-y-3 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <SymbolIcon name="favorite" size={21} />
            <SymbolIcon name="chat_bubble" size={21} />
            <SymbolIcon name="send" size={21} />
          </div>
          <SymbolIcon name="bookmark" size={21} />
        </div>

        {images.length > 1 && (
          <div className="flex justify-center gap-1">
            {images.map((_, index) => (
              <span
                key={index}
                className={`h-1.5 w-1.5 rounded-full ${index === activeIndex ? "bg-blue-500" : "bg-gray-300"}`}
              />
            ))}
          </div>
        )}

        {editable ? (
          <div className="space-y-2">
            <textarea
              value={caption}
              onChange={(event) => onCaptionChange?.(event.target.value)}
              rows={compact ? 4 : 6}
              className="w-full resize-none rounded-md border border-gray-200 bg-white px-3 py-2 text-sm leading-6 outline-none transition focus:border-brand-orange-500 dark:border-gray-700 dark:bg-gray-950"
              placeholder="본문을 입력하세요"
            />
            <textarea
              value={hashtags}
              onChange={(event) => onHashtagsChange?.(event.target.value)}
              rows={2}
              className="w-full resize-none rounded-md border border-gray-200 bg-white px-3 py-2 text-sm leading-6 text-blue-600 outline-none transition focus:border-brand-orange-500 dark:border-gray-700 dark:bg-gray-950 dark:text-blue-300"
              placeholder="#해시태그"
            />
          </div>
        ) : (
          <div className="space-y-2 text-sm leading-6">
            <p className={compact ? "line-clamp-4 whitespace-pre-line" : "whitespace-pre-line"}>{caption}</p>
            <p className="text-blue-600 dark:text-blue-300">{hashtags}</p>
          </div>
        )}
      </div>
    </div>
  );
}
