"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { youtubeNocookieEmbedUrl, youtubeThumbnailUrl, type SessionVideoPlayback } from "@/lib/sessionVideo/rules";

/** 길이(초) → "0:42" */
function durationLabel(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 수업 영상 한 개 재생 부품(학부모·선생님 미리보기 공용) — 배치는 쓰는 화면이 정한다.
 *
 * - youtube: 처음엔 썸네일만(유튜브 쪽으로 아무 요청도 안 간다) → 누르면 youtube-nocookie iframe.
 *   sandbox 로 새 창·최상위 이동을 막아 학부모가 유튜브 사이트로 빠져나가지 않게 한다.
 *   referrerPolicy 는 «origin 만» 보낸다(유튜브가 출처 없는 임베드를 거절하므로 no-referrer 는 못 쓴다).
 * - file : 우리 저장소 사본(10분짜리 서명 주소) — 화면 안에서 재생(playsinline), 미리 받지 않음(metadata).
 * - none : 사본이 지워졌고 유튜브도 준비 안 됨 → 안내 문구.
 */
export function SessionVideoPlayer({ video, onPlaybackError }: { video: SessionVideoPlayback; onPlaybackError?: () => void }) {
  const [playing, setPlaying] = useState(false);
  const duration = durationLabel(video.durationSec);

  if (video.kind === "youtube") {
    return (
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-[var(--color-academy-ink)]">
        {playing ? (
          <iframe
            src={youtubeNocookieEmbedUrl(video.youtubeId)}
            title="수업 영상"
            className="absolute inset-0 size-full"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-presentation"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button type="button" onClick={() => setPlaying(true)} aria-label="수업 영상 재생" className="group absolute inset-0 size-full">
            {/* 유튜브 썸네일 — 외부 이미지라 next/image 최적화를 거치지 않는다 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={youtubeThumbnailUrl(video.youtubeId)} alt="" loading="lazy" className="size-full object-cover opacity-90 group-hover:opacity-100" />
            {/* 버튼은 글자로 말한다(아이콘 대신 «재생») */}
            <span className="absolute inset-0 grid place-items-center">
              <span aria-hidden="true" className="grid min-h-11 min-w-20 place-items-center rounded-full bg-[var(--color-academy-surface)] px-4 text-sm font-semibold text-[var(--color-academy-ink)]">재생</span>
            </span>
            {duration && <span className="absolute bottom-2 right-2 rounded bg-[var(--color-academy-ink)] px-1.5 py-0.5 text-xs text-[var(--color-academy-on-primary)]">{duration}</span>}
          </button>
        )}
      </div>
    );
  }

  if (video.kind === "file") {
    return (
      <video
        // 서명 주소가 바뀌면(다시 불러오기) 새 요소로 갈아 끼운다
        key={video.url}
        controls
        playsInline
        preload="metadata"
        controlsList="nodownload"
        className="aspect-video w-full rounded-xl bg-[var(--color-academy-ink)]"
        // <source> 를 쓰지 않고 src 에 바로 둔다 — <source> 오류는 video 의 onError 로 올라오지 않는다.
        // 아이폰 MOV(H.264)도 형식 표시 없이 주면 대부분의 브라우저가 재생한다.
        src={video.url}
        onError={onPlaybackError}
      >
        이 기기에서는 영상을 재생할 수 없습니다.
      </video>
    );
  }

  return (
    <div className="grid aspect-video w-full place-items-center rounded-xl bg-[var(--color-academy-soft)] p-3 text-center text-sm text-[var(--color-academy-muted)]">
      영상을 준비하고 있습니다. 잠시 뒤 다시 열어 주세요.
    </div>
  );
}

/**
 * 수업 하나의 영상 목록(학부모) — /api/sessions/[sessionId]/videos 를 불러 SessionVideoPlayer 로 그린다.
 * 영상이 없거나 권한이 없으면 아무것도 그리지 않는다(빈 칸으로 화면을 차지하지 않게).
 * 서명 주소는 10분이면 만료된다 — 재생 오류가 나면 한 번만 다시 불러온다.
 */
export function SessionVideoList({ sessionId, className }: { sessionId: string; className?: string }) {
  const [videos, setVideos] = useState<SessionVideoPlayback[]>([]);
  const reloadedRef = useRef(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/videos`, { cache: "no-store" });
    if (!response.ok) { setVideos([]); return; }
    const body = await response.json().catch(() => ({})) as { videos?: SessionVideoPlayback[] };
    setVideos(Array.isArray(body.videos) ? body.videos : []);
  }, [sessionId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load().catch(() => setVideos([])); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (videos.length === 0) return null;
  return (
    <div className={className ?? "grid gap-2"} aria-label="수업 영상">
      {videos.map((video) => (
        <SessionVideoPlayer
          key={video.id}
          video={video}
          onPlaybackError={() => {
            if (reloadedRef.current) return;
            reloadedRef.current = true;
            void load().catch(() => undefined);
          }}
        />
      ))}
    </div>
  );
}
