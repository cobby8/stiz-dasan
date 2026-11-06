import Link from "next/link";
import TrustBadges from "@/components/landing/TrustBadges";
import ProcessSteps from "@/components/landing/ProcessSteps";
import TestimonialCarousel from "@/components/landing/TestimonialCarousel";
import CTABanner from "@/components/landing/CTABanner";
import HomeHeroSlider from "@/components/landing/HomeHeroSlider";
import SectionLayout from "@/components/ui/SectionLayout";
import { isDurableGalleryMediaUrl, parseGalleryMediaJSON } from "@/lib/galleryMedia";
import { formatKstDate, toKstYmd } from "@/lib/datetime/kst";
import "@/components/landing/public-home.css";

type GalleryPost = { id: string; title: string | null; caption: string | null; mediaJSON: string; createdAt: Date | string; className?: string | null };
type GalleryMediaItem = { url: string; type: "image" | "video"; alt: string };
type HomeNotice = { id: string; title: string; isPinned: boolean; createdAt: Date | string };

function getGalleryMediaItems(posts: GalleryPost[]): GalleryMediaItem[] {
  return posts.flatMap((post) => parseGalleryMediaJSON(post.mediaJSON).map((item, index) => ({
    ...item, alt: post.title || post.caption || `학원 활동 사진 ${index + 1}`,
  })));
}

export default function LandingPageClient({ initialSettings, testimonials, galleryPosts = [], notices = [], naverPlaceUrl }: {
  initialSettings: any;
  testimonials?: { name: string; info: string; text: string; rating: number }[];
  galleryPosts?: GalleryPost[];
  notices?: HomeNotice[];
  naverPlaceUrl?: string;
}) {
  const settings = initialSettings || {};
  const phone = settings.contactPhone || "010-0000-0000";
  // 공개 갤러리의 안정적인 사진만 재사용한다. 조회 범위와 원본 데이터는 그대로 둔다.
  const galleryMediaItems = getGalleryMediaItems(galleryPosts)
    .filter((item) => item.type === "image" && isDurableGalleryMediaUrl(item.url))
    .slice(0, 8);
  const displayImages = galleryMediaItems.map((item) => item.url);
  // 첫 화면 슬라이드: 지금까지 쓰던 대표 사진을 첫 장으로 두고, 최근 공개 사진 2장을 더한다.
  const heroPhoto = galleryMediaItems.at(-1);
  const heroSlides = heroPhoto
    ? [heroPhoto, ...galleryMediaItems.filter((item) => item.url !== heroPhoto.url).slice(0, 2)].map(({ url, alt }) => ({ url, alt }))
    : [];

  return (
    <>
      <HomeHeroSlider slides={heroSlides}>
        {/* 화면을 거의 채우는 큰 사진 위에 제목·소개·버튼을 아래쪽에 둔다(원장 요청 2026-11-06).
            현재 문구와 신청·프로그램 이동 경로는 그대로 유지한다. */}
        <div className="public-home-hero__content">
          <div className="public-home-hero__text">
            <h1 id="public-home-title">{settings.introductionTitle || "스티즈 농구교실"}</h1>
            <p className="public-home-lead">우리 아이에게 맞는 수업을 만나보세요.</p>
          </div>
          <div className="public-home-hero__actions">
            <Link href="/apply">체험·수강 신청 <span aria-hidden="true">↗</span></Link>
            <Link href="/programs">전체 프로그램 보기 <span aria-hidden="true">→</span></Link>
          </div>
        </div>
      </HomeHeroSlider>
      {/* 철학 한 줄(원장 선택 2026-11-07) — 넓은 여백 가운데 큰 글씨 한 줄 + 설명. 소개 전문은 /about 에 그대로 있다. */}
      <section className="public-home-philosophy" aria-labelledby="public-home-philosophy-title">
        <h2 id="public-home-philosophy-title">잘하는 것보다, 좋아하는 게 먼저예요.</h2>
        <p>농구가 즐거워야 자신감도 실력도 따라옵니다.<br />아이가 먼저 기다리는 수업을 만듭니다.</p>
        <Link href="/about">학원과 코치진 소개 <span aria-hidden="true">→</span></Link>
      </section>
      <div className="public-home-updates">
        {notices.length > 0 && <section className="public-home-notices" aria-labelledby="public-home-notices-title">
          <div className="public-home-notices__heading"><h2 id="public-home-notices-title">공지사항</h2><Link href="/notices">전체보기 <span aria-hidden="true">→</span></Link></div>
          <ul>{notices.map((notice) => <li key={notice.id}><Link href={`/notices/${notice.id}`}>
            {notice.isPinned && <span className="public-home-notices__pin">중요</span>}
            <span className="public-home-notices__title">{notice.title}</span>
            <time dateTime={toKstYmd(notice.createdAt) || undefined}>{formatKstDate(notice.createdAt, { year: "numeric", month: "short", day: "numeric" })}</time>
          </Link></li>)}</ul>
        </section>}
      </div>
      <TrustBadges />
      <ProcessSteps />
      {settings.youtubeUrl && (() => {
        const raw = settings.youtubeUrl as string;
        const srcMatch = raw.match(/src=["']([^"']+)["']/);
        const url = srcMatch ? srcMatch[1] : raw;
        const videoId = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/)?.[1];
        if (!videoId) return null;
        return <SectionLayout compactHeading title="스티즈 농구교실 영상" bgColor="white" className="public-content-section"><div className="public-home-video">
          <iframe src={`https://www.youtube.com/embed/${videoId}?rel=0`} title="STIZ 농구교실 소개" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen loading="lazy" />
        </div></SectionLayout>;
      })()}
      {displayImages.length > 0 && <SectionLayout compactHeading title="학원 활동 사진" bgColor="section" className="public-content-section">
        <div className="public-home-gallery">{displayImages.map((url, i) => <Link key={url} href="/gallery" aria-label={`학원 활동 사진 ${i + 1} · 갤러리 보기`}>
          <img src={url} alt={`학원 활동 사진 ${i + 1}`} loading="lazy" decoding="async" />
        </Link>)}</div>
        <div className="public-home-gallery__more"><Link href="/gallery">더 많은 사진 보기 <span aria-hidden="true">→</span></Link></div>
      </SectionLayout>}
      <TestimonialCarousel testimonials={testimonials} naverPlaceUrl={naverPlaceUrl} />
      <CTABanner variant="outline" phone={phone} />
    </>
  );
}
