import Link from "next/link";
import TrustBadges from "@/components/landing/TrustBadges";
import ProcessSteps from "@/components/landing/ProcessSteps";
import TestimonialCarousel from "@/components/landing/TestimonialCarousel";
import CTABanner from "@/components/landing/CTABanner";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import { sanitizeHtml } from "@/lib/sanitize";
import { isDurableGalleryMediaUrl, parseGalleryMediaJSON } from "@/lib/galleryMedia";
import { publicIntroduction } from "@/lib/public-design";

type GalleryPost = { id: string; title: string | null; caption: string | null; mediaJSON: string; createdAt: Date | string; className?: string | null };
type HomeNotice = { id: string; title: string; isPinned: boolean; createdAt: Date | string };
type HomeSettings = { contactPhone?: string | null; introductionTitle?: string | null; introductionText?: string | null; youtubeUrl?: string | null };

export default function LandingPageClient({ initialSettings, testimonials = [], galleryPosts = [], notices = [], naverPlaceUrl }: {
  initialSettings: HomeSettings | null;
  testimonials?: { name: string; info: string; text: string; rating: number }[];
  galleryPosts?: GalleryPost[];
  notices?: HomeNotice[];
  naverPlaceUrl?: string;
}) {
  const settings = initialSettings || {};
  const media = galleryPosts.flatMap((post) => parseGalleryMediaJSON(post.mediaJSON).map((item) => ({ ...item, alt: post.title || post.caption || "농구 수업 활동 사진" }))).filter((item) => item.type === "image" && isDurableGalleryMediaUrl(item.url));
  // 대표 사진은 실제 공개 사진만 쓰고, 아래 사진 목록에서 반복하지 않는다.
  const uniqueMedia = media.filter((item, index) => media.findIndex((other) => other.url === item.url) === index);
  const heroImage = uniqueMedia[0];
  const galleryImages = uniqueMedia.slice(1, 5);
  const introduction = publicIntroduction(settings.introductionText || "아이들이 농구를 통해 협동심과 건강한 체력을 기를 수 있도록 지도합니다.");
  const longIntroduction = introduction.replace(/<[^>]*>/g, "").length > 160;
  const introductionHtml = sanitizeHtml(introduction.includes("<") ? introduction : introduction.replace(/\n/g, "<br>"));
  const rawVideo = settings.youtubeUrl || "";
  const videoUrl = rawVideo.match(/src=["']([^"']+)["']/)?.[1] || rawVideo;
  const videoId = videoUrl.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/)?.[1];

  return <>
    <section className="public-section">
      <div className={`public-container grid items-center gap-6 lg:gap-10 ${heroImage ? "lg:grid-cols-2" : "max-w-4xl"}`}>
        <div className="min-w-0">
          <p className="public-eyebrow">STIZ BASKETBALL · 다산2호점</p>
          <h1 className="mt-3 text-[clamp(2rem,4.5vw,3.5rem)] font-extrabold leading-[1.2] tracking-tight [text-wrap:balance] text-[var(--color-public-text)]">{publicIntroduction(settings.introductionTitle || "스티즈 농구교실") || "스티즈 농구교실"}</h1>
          {longIntroduction ? <p className="mt-4 text-base leading-relaxed text-[var(--color-public-muted)]">농구를 즐기며 체력과 협동심을 키웁니다. 우리 아이에게 맞는 수업과 시간대를 만나보세요.</p> : <div className="mt-4 text-base leading-relaxed text-[var(--color-public-muted)] [&_p]:mb-2" dangerouslySetInnerHTML={{ __html: introductionHtml }} />}
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/apply/trial" className="public-button">체험 수업 신청 <FontFreeIcon name="arrow_forward" size={19} /></Link>
            <Link href="/programs" className="public-button-secondary">수업 안내 보기</Link>
          </div>
          {longIntroduction && <details className="mt-4 text-sm text-[var(--color-public-muted)]"><summary className="min-h-11 cursor-pointer py-2">학원의 교육 방향 더 보기</summary><div className="mt-2 leading-relaxed [&_p]:mb-2" dangerouslySetInnerHTML={{ __html: introductionHtml }} /></details>}
        </div>
        {heroImage && <div className="relative overflow-hidden rounded-2xl bg-[var(--color-public-soft)]">
          <img src={heroImage.url} alt={heroImage.alt} fetchPriority="high" decoding="async" className="aspect-[4/3] w-full object-cover" />
          <Link href="/gallery" className="public-button-secondary absolute bottom-3 right-3">수업 현장 보기 <FontFreeIcon name="arrow_forward" size={17} /></Link>
        </div>}
      </div>
      <div className="public-container mt-6"><TrustBadges /></div>
    </section>
    {notices.length > 0 && <section aria-label="학원 새 소식" className="border-y border-[var(--color-public-border)] bg-[var(--color-public-surface)]">
      <div className="public-container flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:gap-5">
        <Link href="/notices" className="public-link inline-flex shrink-0 items-center gap-2 font-bold"><FontFreeIcon name="campaign" size={19} />새 소식</Link>
        <div className="min-w-0 flex-1 divide-y divide-[var(--color-public-border)] sm:divide-y-0">
          {notices.slice(0, 2).map((notice) => <Link key={notice.id} href={`/notices/${notice.id}`} className="flex min-h-11 items-center gap-3 py-2 text-sm text-[var(--color-public-text)]">
            {notice.isPinned && <span className="shrink-0 rounded px-2 py-1 text-xs font-bold bg-[var(--color-public-soft)] text-[var(--color-public-accent)]">중요</span>}
            <span className="min-w-0 flex-1 truncate">{notice.title}</span>
            <span className="shrink-0 text-xs text-[var(--color-public-muted)]">{new Date(notice.createdAt).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })}</span><FontFreeIcon name="chevron_right" size={17} />
          </Link>)}
        </div>
      </div>
    </section>}
    {(galleryImages.length > 0 || videoId) && <section className="public-section"><div className="public-container">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="public-eyebrow">농구로 함께 자라는 시간</p><h2 className="mt-2 text-2xl font-extrabold text-[var(--color-public-text)]">우리 학원의 수업 현장</h2></div><Link href="/gallery" className="public-link inline-flex min-h-11 items-center gap-1">사진 더 보기 <FontFreeIcon name="arrow_forward" size={18} /></Link></div>
      {galleryImages.length > 0 && <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{galleryImages.map((image) => <Link key={image.url} href="/gallery" className="overflow-hidden rounded-xl bg-[var(--color-public-soft)]"><img src={image.url} alt={image.alt} loading="lazy" decoding="async" className="aspect-[4/3] w-full object-cover" /></Link>)}</div>}
      {videoId && <details className="public-card mt-4"><summary className="flex min-h-12 cursor-pointer items-center gap-2 px-4 py-3 font-bold text-[var(--color-public-text)]"><FontFreeIcon name="play_arrow" size={21} />학원 소개 영상 보기</summary><div className="px-3 pb-3"><iframe src={`https://www.youtube.com/embed/${videoId}?rel=0`} title="STIZ 농구교실 소개" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen className="aspect-video w-full rounded-xl border-0" /></div></details>}
    </div></section>}
    <TestimonialCarousel testimonials={testimonials} naverPlaceUrl={naverPlaceUrl} />
    <ProcessSteps />
    <CTABanner phone={settings.contactPhone || undefined} primaryHref="/apply/trial" />
  </>;
}
