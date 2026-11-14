import Link from "next/link";
import { kstLabel } from "@/lib/datetime/kst";
import type { FeedCard } from "@/lib/feed/rules";

/**
 * 학부모 홈 «최신 수업 피드» 카드(2026-11-14 원장 결정) — 고른 아이의 최신 공개 수업 1건.
 * 높이 ~180px 이하: 제목줄(더보기) · 날짜·반·코치 1줄 · 본문 2줄 · 사진 최대 3장 가로 넘김 + «영상 n».
 * 사진·본문·영상을 누르면 소식 상세로 간다. 카드가 없으면(card=null) 부모가 칸 자체를 그리지 않는다.
 * 사진은 서버가 «이 보호자가 실제로 열 수 있는 것만» 넘긴다(수업 피드 공용 판정).
 */
export default function LatestFeedCard({ card }: { card: FeedCard }) {
  const href = `/mypage/reports/${encodeURIComponent(card.sessionId)}`;
  const body = card.content || card.topic || "수업 소식이 올라왔어요.";
  return (
    <section aria-labelledby="latest-feed-heading" className="academy-panel overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-academy-line)] pl-3">
        <h2 id="latest-feed-heading" className="academy-section-title py-2">최신 수업 피드</h2>
        <Link href="/mypage/reports#news-reports" className="academy-button-text academy-button-sm shrink-0">
          더보기
        </Link>
      </div>
      <div className="space-y-1.5 px-3 py-2">
        <Link href={href} className="block">
          {/* 날짜 · 반 · 담당 코치 — 한 줄 */}
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-[var(--color-academy-muted)]">
            <span className="tabular-nums font-medium text-[var(--color-academy-ink)]">{kstLabel(card.ymd)}</span>
            <span className="break-keep">{card.className}</span>
            {card.coachName && <span>{card.coachName} 코치</span>}
          </p>
          {/* 본문 2줄 — 넘치면 상세에서 전부 본다 */}
          <p className="mt-0.5 line-clamp-2 break-keep text-sm leading-5 text-[var(--color-academy-ink)]">{body}</p>
        </Link>
        {(card.photos.length > 0 || card.videoCount > 0) && (
          // 사진 최대 3장 가로 넘김 + 영상 개수 — 누르면 상세
          <ul className="flex gap-1.5 overflow-x-auto" aria-label="최신 수업 사진·영상">
            {card.photos.map((photo, index) => (
              <li key={photo.src} className="shrink-0">
                <Link href={href} aria-label={`수업 사진 ${index + 1} 보기`} className="block h-14 w-14 overflow-hidden rounded-lg bg-[var(--color-academy-soft)]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photo.src} alt="" loading="lazy" className="h-full w-full object-cover" />
                </Link>
              </li>
            ))}
            {card.photoCount > card.photos.length && (
              <li className="shrink-0">
                <Link href={href} className="flex h-14 min-w-14 items-center justify-center rounded-lg bg-[var(--color-academy-soft)] px-2 text-xs font-medium tabular-nums text-[var(--color-academy-muted)]">
                  +{card.photoCount - card.photos.length}
                </Link>
              </li>
            )}
            {card.videoCount > 0 && (
              <li className="shrink-0">
                <Link href={href} className="flex h-14 min-w-14 items-center justify-center rounded-lg border border-[var(--color-academy-line)] px-2 text-xs font-medium tabular-nums text-[var(--color-academy-ink)]">
                  영상 {card.videoCount}
                </Link>
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
