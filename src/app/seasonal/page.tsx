import PublicPageLayout from "@/components/PublicPageLayout";
import SeasonalListClient from "@/components/seasonal/SeasonalListClient";
import { buildPublicMetadata } from "@/lib/publicMetadata";

export const metadata = buildPublicMetadata({
  title: "방학특강 | STIZ 농구교실 다산2호점",
  description: "스티즈 농구교실 다산2호점 방학특강 일정과 모집 현황을 확인하고 모바일로 신청하세요.",
  path: "/seasonal",
});

export default function SeasonalPage() {
  return (
    <PublicPageLayout>
      {/* 어두운 띠 바탕은 공개 테마 토큰(--color-public-dark). 설명 글자 색은 공개 테마의 배너 규칙이 정한다. */}
      <section className="public-page-hero public-page-hero--compact bg-[var(--color-public-dark)] px-5 py-12 text-white">
        <div className="mx-auto max-w-5xl"><h1 className="mt-2 text-3xl font-bold md:text-4xl">방학특강</h1><p className="mt-3 max-w-xl break-keep">방학 동안 집중해서 배우고, 즐겁게 성장하는 프로그램을 만나보세요.</p></div>
      </section>
      <section className="public-content-section bg-[var(--color-public-tint)] px-4 py-8 dark:bg-[var(--color-public-paper)] md:py-12"><div className="mx-auto max-w-5xl"><SeasonalListClient /></div></section>
    </PublicPageLayout>
  );
}
