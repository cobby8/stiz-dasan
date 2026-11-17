"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { bindLightboxToHistory } from "@/lib/navigation/photoLightboxHistory";

/**
 * 수업 사진 바둑판 + 누르면 크게 보기(학부모 소식 상세) — 2026-11-14 수업 피드.
 * - 서버가 «볼 수 있는 사진만» 넘긴다(403 헛요청 없음). 그래도 못 불러온 사진은 칸을 감춘다.
 * - 크게 보기: 화면 전체 어두운 바탕 + 사진 + 이전·다음·닫기 글자 버튼(아이콘 없음), Esc 로 닫기.
 * - 크게 보기(FeedPhotoLightbox)는 수업 리포트 피드(옆으로 넘기는 사진)도 같이 쓴다(2026-11-17 g2).
 */

/**
 * 수업 사진을 기기로 가져가기 어렵게 하는 속성 묶음(2026-11-17 원장 결정 g2) — 다른 아이 얼굴이 함께 찍힌 사진이라서다.
 * - 길게 누르기·오른쪽 누르기 메뉴를 띄우지 않는다(onContextMenu)
 * - 끌어서 다른 곳에 놓지 못하게 한다(draggable)
 * - 아이폰의 길게 누르기 메뉴·글자 고르기를 끈다(className 의 touch-callout·select-none)
 * 화면 캡처는 막을 수 없다 — 쉬운 길만 닫는 장치다.
 */
export const PROTECTED_PHOTO_CLASS = "select-none [-webkit-touch-callout:none] [-webkit-user-drag:none]";
export const protectedPhotoProps = {
  draggable: false,
  onContextMenu: (event: MouseEvent) => event.preventDefault(),
  onDragStart: (event: MouseEvent) => event.preventDefault(),
} as const;

/**
 * 사진 크게 보기 — 화면 전체 어두운 바탕 + 사진 + 이전·다음·닫기 글자 버튼. Esc·바탕 누르기로 닫는다.
 * index 가 null 이면 아무것도 그리지 않는다. 몇 번째 사진인지는 부르는 쪽이 들고 있다(onMove 로 ±1).
 */
export function FeedPhotoLightbox({
  photos,
  index,
  onClose,
  onMove,
}: {
  photos: Array<{ src: string }>;
  index: number | null;
  onClose: () => void;
  onMove: (step: number) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const open = index !== null;
  // 닫기 함수는 부르는 쪽이 새로 만들 수 있다 — 기록 연결(아래)이 열려 있는 동안 다시 묶이지 않게 최신 값만 들고 있는다
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // 휴대폰 «뒤로»로 닫기(2026-11-17 검수 반영) + 닫은 뒤 원래 누른 사진 버튼으로 포커스 돌려주기.
  // 열릴 때 한 번만 묶고(사진 넘기기로 index 가 바뀌어도 기록을 더 넣지 않는다), 닫히거나 사라질 때 푼다.
  // 기록 규칙은 photoLightboxHistory 한 곳 — 학부모 «뒤로» 이동 기록(inAppHistory)에는 아무것도 쌓지 않는다(그 파일 설명 참고).
  useEffect(() => {
    if (!open) return;
    // 열기 직전에 누른 사진 버튼(부르는 쪽이 누를 때 포커스를 옮겨 둔다 — 아이폰은 눌러도 포커스가 안 간다)
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const release = bindLightboxToHistory(window, () => onCloseRef.current());
    return () => {
      release(); // 버튼·Esc·바탕으로 닫았으면 넣었던 기록 한 칸을 되돌린다(«뒤로»로 닫혔으면 아무것도 안 한다)
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (index === null) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowRight") onMove(1);
      else if (event.key === "ArrowLeft") onMove(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, onClose, onMove]);

  const current = index !== null ? photos[index] : null;
  if (!current || index === null) return null;

  // 겹침 순서 z-[80]: 학부모 하단 메뉴(z-50)·알림 시트(z-[60]/z-[70])보다 위 — 같거나 낮으면 휴대폰에서 «이전·다음»이 하단 메뉴에 가려진다(2026-11-17 재검수)
  return (
    <div role="dialog" aria-modal="true" aria-label={`수업 사진 ${index + 1} / ${photos.length}`}
      className="fixed inset-0 z-[80] flex flex-col bg-black/90" onClick={onClose}>
      <div className="flex items-center justify-between px-3 py-2 text-sm text-white">
        <span className="tabular-nums">{index + 1} / {photos.length}</span>
        <button ref={closeRef} type="button" onClick={onClose} className="min-h-11 rounded-lg px-3 font-medium text-white">닫기</button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center px-2" onClick={(event) => event.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={current.src} alt={`수업 사진 ${index + 1}`} {...protectedPhotoProps} className={`max-h-full max-w-full object-contain ${PROTECTED_PHOTO_CLASS}`} />
      </div>
      {photos.length > 1 && (
        <div className="grid grid-cols-2 gap-2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2" onClick={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => onMove(-1)} className="min-h-11 rounded-lg bg-white/15 text-sm font-medium text-white">이전</button>
          <button type="button" onClick={() => onMove(1)} className="min-h-11 rounded-lg bg-white/15 text-sm font-medium text-white">다음</button>
        </div>
      )}
    </div>
  );
}

export default function FeedPhotoGallery({ photos }: { photos: Array<{ src: string }> }) {
  const [failed, setFailed] = useState<Record<string, true>>({});
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const visible = photos.filter((photo) => !failed[photo.src]);

  const close = useCallback(() => setOpenIndex(null), []);
  const move = useCallback((step: number) => {
    setOpenIndex((current) => current === null ? null : (current + step + visible.length) % visible.length);
  }, [visible.length]);

  if (visible.length === 0) return null;

  return (
    <>
      <ul className="grid grid-cols-3 gap-1.5" aria-label="수업 사진">
        {visible.map((photo, index) => (
          <li key={photo.src}>
            {/* 누를 때 이 버튼에 포커스를 옮겨 둔다 — 크게 보기를 닫으면 여기로 돌아온다(아이폰은 눌러도 포커스가 안 간다) */}
            <button type="button" onClick={(event) => { event.currentTarget.focus(); setOpenIndex(index); }} aria-label={`수업 사진 ${index + 1} 크게 보기`}
              className="block aspect-square w-full overflow-hidden rounded-lg bg-[var(--color-academy-soft)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo.src} alt={`수업 사진 ${index + 1}`} loading="lazy" {...protectedPhotoProps} className={`h-full w-full object-cover ${PROTECTED_PHOTO_CLASS}`}
                onError={() => setFailed((prev) => ({ ...prev, [photo.src]: true }))} />
            </button>
          </li>
        ))}
      </ul>
      <FeedPhotoLightbox photos={visible} index={openIndex} onClose={close} onMove={move} />
    </>
  );
}
