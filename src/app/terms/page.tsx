import { getAcademySettings } from "@/lib/queries";
import PublicPageLayout from "@/components/PublicPageLayout";
import SectionLayout from "@/components/ui/SectionLayout";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import ProgramAccordionTerms from "@/app/programs/ProgramAccordionTerms";
import { buildPublicMetadata } from "@/lib/publicMetadata";

// 이용약관은 자주 바뀌지 않으므로 5분 ISR
export const revalidate = 300;
export const metadata = buildPublicMetadata({
  title: "이용약관 | STIZ 농구교실 다산2호점",
  description: "STIZ 농구교실 다산2호점 이용약관과 수강 규정, 환불 정책, 보강 안내를 확인하세요.",
  path: "/terms",
});

export default async function TermsPage() {
  // DB에서 이용약관 텍스트를 가져온다
  const settings = (await getAcademySettings()) as any;
  const termsOfService: string | null = settings.termsOfService ?? null;

  return (
    <PublicPageLayout>
      {/* 페이지 히어로 */}
      <section className="public-page-hero public-page-hero--compact relative overflow-hidden bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 dark:from-black dark:via-gray-900 dark:to-black text-white py-12 md:py-14 transition-colors duration-300">
        <div className="max-w-6xl mx-auto px-6 md:px-4 relative">
          <AnimateOnScroll>
            <h1 className="text-4xl md:text-5xl font-black mb-4 break-keep">이용약관</h1>
            <p className="text-blue-200 text-lg max-w-xl">수강 규정 및 환불 정책을 확인하세요.</p>
          </AnimateOnScroll>
        </div>
      </section>

      {/* 이용약관 본문 — 기존 ProgramAccordionTerms 컴포넌트 재사용 */}
      <SectionLayout className="public-content-section" bgColor="section">
        {termsOfService ? (
          <AnimateOnScroll>
            <ProgramAccordionTerms termsText={termsOfService} hideHeader />
          </AnimateOnScroll>
        ) : (
          <div className="text-center py-20 text-gray-400">
            <p className="text-lg font-medium">이용약관이 아직 등록되지 않았습니다.</p>
          </div>
        )}
      </SectionLayout>
    </PublicPageLayout>
  );
}
