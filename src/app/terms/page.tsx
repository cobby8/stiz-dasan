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
  const settings = (await getAcademySettings()) as { termsOfService?: string | null };
  const termsOfService: string | null = settings.termsOfService ?? null;

  return (
    <PublicPageLayout>
      {/* 페이지 히어로 */}
      <section className="public-page-intro">
        <div className="public-container">
          <h1>이용약관</h1>
          <p>수강 규정과 환불·보강 기준을 확인하세요.</p>
        </div>
      </section>

      {/* 이용약관 본문 — 기존 ProgramAccordionTerms 컴포넌트 재사용 */}
      <SectionLayout bgColor="section">
        {termsOfService ? (
          <AnimateOnScroll>
            <ProgramAccordionTerms termsText={termsOfService} hideHeader />
          </AnimateOnScroll>
        ) : (
          <div className="public-card p-6 text-center text-gray-500">
            <p className="text-lg font-medium">이용약관이 아직 등록되지 않았습니다.</p>
          </div>
        )}
      </SectionLayout>
    </PublicPageLayout>
  );
}
