"use client";

import { useState } from "react";

// 프로필 사진 동그라미(2026-11-15) — 학생·학부모 공용 부품.
//  · 사진이 있으면 사진, 없거나 불러오지 못하면 **이름 첫 글자**를 보조 색 바탕 위에 그린다(아이콘·이모지 없음).
//  · 폭·높이를 고정해 사진이 늦게 떠도 옆 글자가 밀리지 않는다.
//  · 크기는 세 가지만: 28(칩) · 40(목록 줄) · 64(제목 옆).

export type ProfileAvatarSize = 28 | 40 | 64;

// 크기별 첫 글자 크기 — 12px 아래로 내려가지 않는다
const INITIAL_TEXT: Record<ProfileAvatarSize, string> = { 28: "text-xs", 40: "text-base", 64: "text-2xl" };

/** 이름 첫 글자(한글·영문·이모지 한 글자 단위). 이름이 비면 «?» */
export function profileInitial(name: string): string {
  return Array.from((name ?? "").trim())[0] ?? "?";
}

export default function ProfileAvatar({
  name,
  src,
  size = 40,
  decorative = false,
}: {
  name: string;
  /** 사진 주소(없으면 null → 이름 첫 글자) */
  src: string | null;
  size?: ProfileAvatarSize;
  /** 바로 옆에 이름 글자가 있으면 true — 화면 낭독기가 이름을 두 번 읽지 않게 한다 */
  decorative?: boolean;
}) {
  // 불러오지 못한 주소를 기억해 둔다(주소가 바뀌면 다시 시도한다)
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showPhoto = Boolean(src) && failedSrc !== src;

  return (
    <span
      // 사진이 없을 때는 이 동그라미가 «이름» 그림 역할을 한다(alt 와 같은 뜻)
      role={!showPhoto && !decorative ? "img" : undefined}
      aria-label={!showPhoto && !decorative ? name : undefined}
      aria-hidden={decorative ? true : undefined}
      style={{ width: size, height: size }}
      className="inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-[var(--color-academy-secondary-soft)] font-semibold leading-none text-[var(--color-academy-secondary-ink)]"
    >
      {showPhoto ? (
        // 권한 확인 API 주소라 next/image 최적화를 거치지 않고 그대로 싣는다
        // eslint-disable-next-line @next/next/no-img-element
        <img
          // 화면이 준비되기(하이드레이션) 전에 이미 불러오기가 실패한 사진은 onError 가 오지 않는다.
          // 붙는 순간 «다 불러왔는데 크기가 0» 이면 실패로 보고 이름 첫 글자로 바꾼다.
          ref={(img) => {
            if (img && img.complete && img.naturalWidth === 0) setFailedSrc(src);
          }}
          src={src as string}
          alt={decorative ? "" : name}
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(src)}
          className="size-full object-cover"
        />
      ) : (
        <span aria-hidden="true" className={INITIAL_TEXT[size]}>{profileInitial(name)}</span>
      )}
    </span>
  );
}
