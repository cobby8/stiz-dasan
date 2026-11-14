"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { SessionVideoList } from "@/components/parent/SessionVideoPlayer";
import {
  REPORT_FEED_PAGE_SIZE,
  appendReportFeedPage,
  reportFeedAttendanceLabel,
  reportFeedWhenLabel,
  withReportFeedDayDividers,
} from "@/lib/feed/reportFeedRules";
import type { ReportFeedPost } from "@/lib/feed/reportFeedServer";
import { ATTENDANCE_TONE, TONE_TEXT_CLASS, type StatusTone } from "@/lib/ui/statusTones";

/**
 * 수업 리포트 피드 화면(클라이언트) — 게시물을 세로로 이어 보고, 끝에 닿으면 다음 장을 받는다.
 * - 처음 장은 서버가 그려서 넘긴다(initialPosts). 다음 장은 /api/mypage/report-feed?cursor= 로.
 * - 다음 장이 실패하면 그 자리에 «다시 불러오기»(자동으로 계속 다시 부르지 않는다 — 서버를 두드리지 않게).
 * - 게시물의 사진 조회가 실패했으면(photos=null) 그 칸만 «사진 다시 불러오기».
 */
export default function ReportFeedClient({
  initialPosts,
  initialCursor,
  startId,
}: {
  initialPosts: ReportFeedPost[];
  initialCursor: string | null;
  startId: string | null;
}) {
  const [posts, setPosts] = useState(initialPosts);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // ── 다음 장 받기 — 한 번에 하나만(빠르게 스크롤해도 같은 장을 두 번 받지 않게) ──
  const loadMore = useCallback(async () => {
    if (!cursor || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const response = await fetch(
        `/api/mypage/report-feed?cursor=${encodeURIComponent(cursor)}&limit=${REPORT_FEED_PAGE_SIZE}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { posts?: ReportFeedPost[]; nextCursor?: string | null };
      setPosts((current) => appendReportFeedPage(current, Array.isArray(body.posts) ? body.posts : []));
      setCursor(typeof body.nextCursor === "string" ? body.nextCursor : null);
    } catch {
      setFailed(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [cursor]);

  // ── 끝에 닿으면 자동으로 다음 장 — 실패한 뒤에는 버튼으로만(무한 재시도 방지) ──
  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || !cursor || failed || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "600px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [cursor, failed, loadMore]);

  // ── ?start= 로 들어왔으면 그 게시물 자리에서 시작 ──
  useEffect(() => {
    if (!startId) return;
    const align = () => document.getElementById(`report-${startId}`)?.scrollIntoView({ block: "start" });
    align();
    // 사진·영상 칸은 높이를 미리 잡아 두지만, 글꼴·머리 영역이 늦게 그려지는 기기(iOS)를 위해
    // 화면이 다 뜬 뒤(load) 한 번 더 맞춘다 — 그사이 사용자가 직접 움직였으면 건드리지 않는다
    let touched = false;
    const markTouched = () => { touched = true; };
    const realign = () => { if (!touched) align(); };
    window.addEventListener("touchstart", markTouched, { once: true, passive: true });
    window.addEventListener("wheel", markTouched, { once: true, passive: true });
    window.addEventListener("keydown", markTouched, { once: true });
    if (document.readyState !== "complete") window.addEventListener("load", realign, { once: true });
    const timer = window.setTimeout(realign, 400);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("load", realign);
      window.removeEventListener("touchstart", markTouched);
      window.removeEventListener("wheel", markTouched);
      window.removeEventListener("keydown", markTouched);
    };
    // 처음 한 번만(다음 장이 붙어도 다시 옮기지 않는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 사진 칸만 새 값으로(사진 다시 불러오기) — 출결 줄·본문은 처음 받은 그대로 둔다
  const replacePhotos = useCallback((postId: string, photos: ReportFeedPost["photos"]) => {
    setPosts((current) => current.map((post) => (post.id === postId ? { ...post, photos } : post)));
  }, []);

  if (posts.length === 0) {
    return (
      <p className="rounded-xl border border-[var(--color-academy-line)] bg-white px-3 py-3 text-sm text-[var(--color-academy-muted)]">
        수업 리포트가 아직 없어요
      </p>
    );
  }

  return (
    <div>
      <ol className="space-y-3" aria-label="수업 리포트">
        {withReportFeedDayDividers(posts).map((row) =>
          row.kind === "day" ? (
            // 날짜 구분줄 — 양옆 가는 선 + 가운데 날짜
            <li key={`day-${row.ymd}-${row.label}`} className="flex items-center gap-2 pt-1" >
              <span className="h-px flex-1 bg-[var(--color-academy-line)]" aria-hidden="true" />
              <span className="text-xs font-medium tabular-nums text-[var(--color-academy-muted)]">{row.label}</span>
              <span className="h-px flex-1 bg-[var(--color-academy-line)]" aria-hidden="true" />
            </li>
          ) : (
            <li key={row.post.id}>
              <ReportFeedPostCard post={row.post} onPhotos={replacePhotos} />
            </li>
          ),
        )}
      </ol>

      {/* 끝 표시 — 화면에 가까워지면 다음 장. 실패하면 버튼 */}
      <div ref={sentinelRef} className="py-3 text-center">
        {failed ? (
          <div className="space-y-1.5">
            <p className="text-sm text-[var(--color-academy-muted)]">다음 소식을 불러오지 못했어요.</p>
            <button type="button" onClick={() => void loadMore()} className="academy-button-secondary min-h-11">
              다시 불러오기
            </button>
          </div>
        ) : cursor ? (
          <button type="button" onClick={() => void loadMore()} disabled={loading} className="academy-button-text min-h-11">
            {loading ? "불러오는 중" : "더 보기"}
          </button>
        ) : (
          <p className="text-xs text-[var(--color-academy-faint)]">마지막 소식이에요</p>
        )}
      </div>
    </div>
  );
}

/** 게시물 하나 = 수업 1회 */
function ReportFeedPostCard({ post, onPhotos }: { post: ReportFeedPost; onPhotos: (postId: string, photos: ReportFeedPost["photos"]) => void }) {
  const when = reportFeedWhenLabel(post.ymd, post.startTime);
  return (
    <article id={`report-${post.id}`} className="scroll-mt-20 overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white">
      {/* 머리줄 — 반 이름 · 11/13(금) 15:00 · 담당 코치 */}
      <header className="flex flex-wrap items-center gap-x-1.5 px-3 py-2 text-sm">
        <span className="break-keep font-semibold text-[var(--color-academy-ink)]">{post.className}</span>
        {when && <span className="tabular-nums text-[var(--color-academy-muted)]">· {when}</span>}
        {post.coachName && <span className="text-[var(--color-academy-muted)]">· {post.coachName} 코치</span>}
      </header>

      {/* 사진 — 조회 실패면 그 칸만 다시 불러오기, 없으면 칸을 그리지 않는다 */}
      {post.photos === null ? (
        <PhotoRetry sessionId={post.id} onPhotos={onPhotos} />
      ) : post.photos.length > 0 ? (
        <PhotoCarousel photos={post.photos} />
      ) : null}

      <div className="space-y-2 px-3 py-2">
        {/* 영상 — 화면 근처에 왔을 때만 불러온다(자리 높이는 미리 잡아 둔다) */}
        {post.videoCount > 0 && <LazyVideoSlot sessionId={post.id} count={post.videoCount} />}

        {/* 수업 주제 + 수업 한 줄 전문 */}
        {post.topic && <p className="break-keep text-sm font-medium text-[var(--color-academy-ink)]">{post.topic}</p>}
        {post.content && <p className="whitespace-pre-line break-keep text-sm leading-6 text-[var(--color-academy-ink)]">{post.content}</p>}
        {!post.topic && !post.content && <p className="text-sm text-[var(--color-academy-muted)]">수업 소식이 올라왔어요.</p>}

        {/* 우리 아이 출결 한 줄 — 조회 실패(null)면 비워 둔다 */}
        {post.children && post.children.length > 0 && (
          <p className="flex flex-wrap gap-x-3 text-xs">
            {post.children.map((child) => (
              <span key={child.id} className="text-[var(--color-academy-muted)]">
                {child.name}{" "}
                <span className={`font-medium ${TONE_TEXT_CLASS[attendanceTone(child.status)]}`}>
                  {reportFeedAttendanceLabel(child.status)}
                </span>
              </span>
            ))}
          </p>
        )}

        {/* 자세히 — 코치 코멘트·참여도까지 보는 상세 */}
        <div className="flex justify-end">
          <Link href={`/mypage/reports/${encodeURIComponent(post.id)}`} className="academy-button-text min-h-11">
            자세히 <span aria-hidden="true">›</span>
          </Link>
        </div>
      </div>
    </article>
  );
}

/** 사진 여러 장 — 옆으로 밀어 넘기기(CSS scroll-snap) + «2/5» */
function PhotoCarousel({ photos }: { photos: Array<{ src: string }> }) {
  const [failedSrc, setFailedSrc] = useState<Record<string, true>>({});
  const [index, setIndex] = useState(0);
  // 다시 불러오기를 누를 때마다 바뀌는 값 — 같은 주소라도 <img> 를 새로 만들어 다시 받게 한다
  const [attempt, setAttempt] = useState(0);
  const visible = photos.filter((photo) => !failedSrc[photo.src]);
  if (visible.length === 0) {
    // 사진이 모두 안 열렸을 때 — 칸을 없애지 않고 같은 높이(정사각형)로 남겨 위치가 밀리지 않게 한다
    return (
      <div className="flex aspect-square w-full flex-col items-center justify-center gap-1 bg-[var(--color-academy-soft)] px-3 text-center">
        <p className="text-sm text-[var(--color-academy-muted)]">사진을 불러오지 못했어요.</p>
        <button type="button" onClick={() => { setFailedSrc({}); setAttempt((n) => n + 1); }} className="academy-button-secondary min-h-11">
          사진 다시 불러오기
        </button>
      </div>
    );
  }
  const shown = Math.min(index, visible.length - 1);

  return (
    <div className="relative bg-[var(--color-academy-soft)]">
      <ul
        className="scrollbar-hide flex snap-x snap-mandatory overflow-x-auto"
        aria-label="수업 사진"
        // 넘긴 장 번호 = 가로 위치 ÷ 한 장 폭
        onScroll={(event) => {
          const el = event.currentTarget;
          if (el.clientWidth > 0) setIndex(Math.round(el.scrollLeft / el.clientWidth));
        }}
      >
        {visible.map((photo, i) => (
          <li key={`${photo.src}#${attempt}`} className="w-full shrink-0 snap-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.src}
              alt={`수업 사진 ${i + 1}`}
              loading="lazy"
              className="aspect-square w-full object-cover"
              // 못 불러온 사진은 칸을 감춘다(빈 네모가 남지 않게)
              onError={() => setFailedSrc((prev) => ({ ...prev, [photo.src]: true }))}
            />
          </li>
        ))}
      </ul>
      {visible.length > 1 && (
        <span className="absolute right-2 top-2 rounded-full bg-[var(--color-academy-ink)] px-2 py-0.5 text-xs tabular-nums text-[var(--color-academy-on-primary)]">
          {shown + 1}/{visible.length}
        </span>
      )}
    </div>
  );
}

/** 사진 조회가 실패한 게시물 — 그 게시물만 다시 받는다 */
function PhotoRetry({ sessionId, onPhotos }: { sessionId: string; onPhotos: (postId: string, photos: ReportFeedPost["photos"]) => void }) {
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const retry = async () => {
    setState("loading");
    try {
      const response = await fetch(`/api/mypage/report-feed?session=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { post?: ReportFeedPost };
      if (!body.post) throw new Error("NO_POST");
      // 다시 받아도 사진 조회가 또 실패했으면(null) 버튼을 남긴다
      if (body.post.photos === null) setState("failed");
      // 사진 칸만 바꾼다(출결 줄·본문은 그대로)
      onPhotos(sessionId, body.post.photos);
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="flex min-h-24 flex-col items-center justify-center gap-1 bg-[var(--color-academy-soft)] px-3 py-3 text-center">
      <p className="text-sm text-[var(--color-academy-muted)]">
        {state === "failed" ? "사진을 아직 불러오지 못했어요." : "사진을 불러오지 못했어요."}
      </p>
      <button type="button" onClick={() => void retry()} disabled={state === "loading"} className="academy-button-secondary min-h-11">
        {state === "loading" ? "불러오는 중" : "사진 다시 불러오기"}
      </button>
    </div>
  );
}

/** 출결 글자의 색 — «확인 중»(기록 없음·모르는 값)은 상세 화면처럼 중립색 */
function attendanceTone(status: string | null): StatusTone {
  if (reportFeedAttendanceLabel(status) === "확인 중") return "neutral";
  return (status && ATTENDANCE_TONE[status]) || "neutral";
}

/**
 * 영상 칸 — 화면 근처(위아래 800px)에 왔을 때만 SessionVideoList 를 붙인다.
 * 왜: 게시물 20개가 한꺼번에 영상 주소를 요청하지 않게, 그리고 ?start= 로 가운데서 시작할 때
 *     위쪽 영상이 늦게 붙으며 화면이 밀리지 않게(iOS).
 * 자리표시 칸(영상 수만큼 16:9)과 실제 영상을 같은 격자 칸에 겹쳐 둔다 — 칸 높이는 둘 중 큰 쪽이라
 * 영상이 붙기 전·붙은 뒤·불러오기 실패 모두 높이가 같다. 영상(어두운 바탕)이 자리표시를 덮는다.
 */
function LazyVideoSlot({ sessionId, count }: { sessionId: string; count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const target = ref.current;
    if (!target || near) return;
    // 관찰 기능이 없는 옛 브라우저는 바로 붙인다
    if (typeof IntersectionObserver === "undefined") {
      const timer = window.setTimeout(() => setNear(true), 0);
      return () => window.clearTimeout(timer);
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNear(true);
        observer.disconnect();
      }
    }, { rootMargin: "800px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [near]);
  return (
    <div ref={ref} className="grid">
      <div className="grid gap-2 [grid-area:1/1]" aria-hidden="true">
        {Array.from({ length: Math.max(1, count) }, (_, i) => (
          <div key={i} className="grid aspect-video w-full place-items-center rounded-xl bg-[var(--color-academy-soft)] text-sm text-[var(--color-academy-muted)]">
            수업 영상
          </div>
        ))}
      </div>
      {near && <SessionVideoList sessionId={sessionId} className="relative grid gap-2 [grid-area:1/1]" />}
    </div>
  );
}
