"use client";

import { useState } from "react";

/**
 * 홈 «스티즈 농구교실 영상» — 처음엔 미리보기 사진만 보이고, 누르면 그 자리에서 유튜브 영상을 튼다(2026-11-17 속도 개선).
 *
 * 왜: 유튜브 재생기를 화면에 바로 넣으면 영상을 보지 않는 방문자도 재생기 파일(수 MB)을 내려받아
 *     홈이 다 뜨는 데 3초 가까이 더 걸렸다. 사진 한 장만 먼저 보이면 그 비용이 «볼 사람»에게만 든다.
 * - 누르기 전에는 유튜브 재생기를 부르지 않는다(사진 한 장만 받는다).
 * - 누르면 바로 재생되도록 autoplay=1 을 붙인다(한 번 더 누르지 않게).
 * - videoId 는 부르는 쪽(LandingPageClient)이 11자 형식으로 걸러서 넘긴다.
 */
export default function HomeVideo({ videoId }: { videoId: string }) {
  const [playing, setPlaying] = useState(false);

  if (playing) {
    return (
      <iframe
        // 버튼이 사라진 자리에 초점을 옮긴다(키보드·화면낭독기 사용자가 문서 처음으로 튕기지 않게)
        ref={(node) => node?.focus()}
        // playsinline: 아이폰에서 전체 화면으로 튀지 않고 그 자리에서 재생
        src={`https://www.youtube.com/embed/${videoId}?rel=0&autoplay=1&playsinline=1`}
        title="STIZ 농구교실 소개"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    );
  }

  return (
    <button type="button" className="public-home-video__poster" onClick={() => setPlaying(true)} aria-label="스티즈 농구교실 영상 재생">
      {/* 유튜브 미리보기 사진 — 외부 이미지라 next/image 최적화를 거치지 않는다 */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`} alt="" loading="lazy" decoding="async" />
      {/* 버튼은 글자로 말한다(아이콘 대신 «영상 재생») */}
      <span aria-hidden="true" className="public-home-video__play">영상 재생</span>
    </button>
  );
}
