"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 수업 사진 바둑판 + 누르면 크게 보기(학부모 소식 상세) — 2026-11-14 수업 피드.
 * - 서버가 «볼 수 있는 사진만» 넘긴다(403 헛요청 없음). 그래도 못 불러온 사진은 칸을 감춘다.
 * - 크게 보기: 화면 전체 어두운 바탕 + 사진 + 이전·다음·닫기 글자 버튼(아이콘 없음), Esc 로 닫기.
 */
export default function FeedPhotoGallery({ photos }: { photos: Array<{ src: string }> }) {
  const [failed, setFailed] = useState<Record<string, true>>({});
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const visible = photos.filter((photo) => !failed[photo.src]);

  const close = useCallback(() => setOpenIndex(null), []);
  const move = useCallback((step: number) => {
    setOpenIndex((current) => current === null ? null : (current + step + visible.length) % visible.length);
  }, [visible.length]);

  useEffect(() => {
    if (openIndex === null) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      else if (event.key === "ArrowRight") move(1);
      else if (event.key === "ArrowLeft") move(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openIndex, close, move]);

  if (visible.length === 0) return null;
  const current = openIndex !== null ? visible[openIndex] : null;

  return (
    <>
      <ul className="grid grid-cols-3 gap-1.5" aria-label="수업 사진">
        {visible.map((photo, index) => (
          <li key={photo.src}>
            <button type="button" onClick={() => setOpenIndex(index)} aria-label={`수업 사진 ${index + 1} 크게 보기`}
              className="block aspect-square w-full overflow-hidden rounded-lg bg-[var(--color-academy-soft)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo.src} alt={`수업 사진 ${index + 1}`} loading="lazy" className="h-full w-full object-cover"
                onError={() => setFailed((prev) => ({ ...prev, [photo.src]: true }))} />
            </button>
          </li>
        ))}
      </ul>
      {current && openIndex !== null && (
        <div role="dialog" aria-modal="true" aria-label={`수업 사진 ${openIndex + 1} / ${visible.length}`}
          className="fixed inset-0 z-50 flex flex-col bg-black/90" onClick={close}>
          <div className="flex items-center justify-between px-3 py-2 text-sm text-white">
            <span className="tabular-nums">{openIndex + 1} / {visible.length}</span>
            <button ref={closeRef} type="button" onClick={close} className="min-h-11 rounded-lg px-3 font-medium text-white">닫기</button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center px-2" onClick={(event) => event.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={current.src} alt={`수업 사진 ${openIndex + 1}`} className="max-h-full max-w-full object-contain" />
          </div>
          {visible.length > 1 && (
            <div className="grid grid-cols-2 gap-2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2" onClick={(event) => event.stopPropagation()}>
              <button type="button" onClick={() => move(-1)} className="min-h-11 rounded-lg bg-white/15 text-sm font-medium text-white">이전</button>
              <button type="button" onClick={() => move(1)} className="min-h-11 rounded-lg bg-white/15 text-sm font-medium text-white">다음</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
