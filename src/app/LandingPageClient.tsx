import Link from "next/link";
import TrustBadges from "@/components/landing/TrustBadges";
import ProcessSteps from "@/components/landing/ProcessSteps";
import TestimonialCarousel from "@/components/landing/TestimonialCarousel";
import CTABanner from "@/components/landing/CTABanner";
import SectionLayout from "@/components/ui/SectionLayout";
import { sanitizeHtml } from "@/lib/sanitize";
import { isDurableGalleryMediaUrl, parseGalleryMediaJSON } from "@/lib/galleryMedia";
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
  const heroPhoto = galleryMediaItems.at(-1);
  const introductionText = settings.introductionText as string | undefined;
  const introductionHtml = sanitizeHtml(!introductionText
    ? "아이들이 농구를 통해 협동심과 건강한 체력을 기를 수 있도록 최선을 다해 지도합니다."
    : introductionText.includes("<") ? introductionText : introductionText.replace(/\n/g, "<br>"));

  return (
    <>
      <section className="public-home-hero" aria-labelledby="public-home-title">
        {heroPhoto && <img src={heroPhoto.url} alt={heroPhoto.alt} fetchPriority="high" decoding="async" className="public-home-hero__image" />}
        <div className="public-home-hero__content">
          <p className="public-home-kicker">STIZ BASKETBALL CLUB · DASAN</p>
          <h1 id="public-home-title">{settings.introductionTitle || "스티즈 농구교실"}</h1>
          <p className="public-home-lead">농구를 즐기며 건강하게 성장하는 시간.<br />우리 아이에게 맞는 수업을 만나보세요.</p>
          <div className="public-home-hero__actions">
            <Link href="/apply">체험·수강 신청 <span aria-hidden="true">↗</span></Link>
            <Link href="/programs">전체 프로그램 보기 <span aria-hidden="true">→</span></Link>
          </div>
        </div>
      </section>
      <div className="public-home-updates">
        <details className="public-home-introduction">
          <summary>학원 소개 더보기</summary>
          <div dangerouslySetInnerHTML={{ __html: introductionHtml }} />
          <Link href="/about">학원과 코치진 소개 <span aria-hidden="true">→</span></Link>
        </details>
        {notices.length > 0 && <section className="public-home-notices" aria-labelledby="public-home-notices-title">
          <div className="public-home-notices__heading"><h2 id="public-home-notices-title">공지사항</h2><Link href="/notices">전체보기 <span aria-hidden="true">→</span></Link></div>
          <ul>{notices.map((notice) => <li key={notice.id}><Link href={`/notices/${notice.id}`}>
            {notice.isPinned && <span className="public-home-notices__pin">중요</span>}
            <span className="public-home-notices__title">{notice.title}</span>
            <time dateTime={new Date(notice.createdAt).toISOString()}>{new Date(notice.createdAt).toLocaleDateString("ko-KR", { month: "short", day: "numeric" })}</time>
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
        return <SectionLayout label="VIDEO" title="스티즈 농구교실 영상" bgColor="white" className="public-content-section"><div className="public-home-video">
          <iframe src={`https://www.youtube.com/embed/${videoId}?rel=0`} title="STIZ 농구교실 소개" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen loading="lazy" />
        </div></SectionLayout>;
      })()}
      {displayImages.length > 0 && <SectionLayout label="GALLERY" title="학원 활동 사진" description="아이들의 즐거운 농구 수업 모습을 확인하세요" bgColor="section" className="public-content-section">
        <div className="public-home-gallery">{displayImages.map((url, i) => <Link key={url} href="/gallery" aria-label={`학원 활동 사진 ${i + 1} · 갤러리 보기`}>
          <img src={url} alt={`학원 활동 사진 ${i + 1}`} loading="lazy" decoding="async" />
        </Link>)}</div>
        <div className="public-home-gallery__more"><Link href="/gallery">더 많은 사진 보기 <span aria-hidden="true">→</span></Link></div>
      </SectionLayout>}
      <TestimonialCarousel testimonials={testimonials} naverPlaceUrl={naverPlaceUrl} />
      <CTABanner phone={phone} />
    </>
  );
}
