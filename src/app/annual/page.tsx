import { loadAnnualPageData } from "./annualData";
import PublicPageLayout from "@/components/PublicPageLayout";
import AnnualEventsClient from "./AnnualEventsClient";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import CTABanner from "@/components/landing/CTABanner";
import { buildPublicMetadata } from "@/lib/publicMetadata";

// ISR: 5분 캐시 (Vercel 엣지 CDN 서빙). admin revalidatePath("/annual") 호출 시 즉각 무효화.
export const revalidate = 300;

export const metadata = buildPublicMetadata({
    title: "연간일정표 | STIZ 농구교실 다산2호점",
    description: "스티즈 농구교실 다산2호점 연간 행사 일정. 대회, 방학, 특별행사 및 정기 일정을 확인하세요.",
    path: "/annual",
});

const CATEGORY_STYLES: Record<string, { dot: string }> = {
    대회: { dot: "bg-orange-500" },
    방학: { dot: "bg-red-500" },
    특별행사: { dot: "bg-purple-500" },
    정기행사: { dot: "bg-blue-500" },
    일반: { dot: "bg-green-500" },
};

export default async function AnnualPage() {
    // 자료 준비(구글 캘린더 + 관리자 등록 일정 + 월별 수업일자)는 annualData.ts 한 곳 — 선생님 앱 «일정»과 같이 쓴다
    const { phone, allEvents, classDays, yearlySchedules } = await loadAnnualPageData();

    const categories = Object.keys(CATEGORY_STYLES);

    return (
        <PublicPageLayout>
            {/* 페이지 히어로 — about/programs/schedule과 동일한 그라데이션 + 장식 도형 패턴 */}
            <section className="public-page-hero public-page-hero--compact relative overflow-hidden bg-gradient-to-br from-[var(--color-public-dark)] via-[var(--color-public-dark)] to-[var(--color-public-dark)] dark:from-black dark:via-gray-900 dark:to-black text-white py-12 md:py-14 transition-colors duration-300">
                <div className="max-w-6xl mx-auto px-6 md:px-4 relative">
                    <AnimateOnScroll>
                        <h1 className="text-4xl md:text-5xl font-[700] mb-4 break-keep">연간일정표</h1>
                        <p className="text-blue-200 text-lg max-w-xl">대회, 방학, 특별 행사 일정을 확인하세요.</p>
                    </AnimateOnScroll>
                </div>
            </section>

            {/* 범례(Legend) — 디자인 개선: pill 뱃지 스타일로 카테고리 표시 */}
            <section className="py-5 bg-white dark:bg-[var(--color-public-paper)] border-b border-[var(--color-public-line)] dark:border-[var(--color-public-line)] transition-colors duration-300">
                <div className="max-w-6xl mx-auto px-4">
                    <div className="flex flex-wrap gap-2.5 items-center">
                        <span className="text-sm font-bold text-[var(--color-public-muted)] mr-1">구분</span>
                        {categories.map((cat) => (
                            <div key={cat} className="inline-flex items-center gap-1.5 bg-[var(--color-public-tint)] dark:bg-[var(--color-public-tint)] px-3 py-1.5 rounded-full border border-[var(--color-public-line)] dark:border-[var(--color-public-line)] transition-colors">
                                <span className={`w-2.5 h-2.5 rounded-full ${CATEGORY_STYLES[cat].dot}`}></span>
                                <span className="text-xs font-bold text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">{cat}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* Events (Client Component - handles year filter, schedule toggle) */}
            <AnnualEventsClient
                allEvents={allEvents}
                classDays={classDays}
                yearlySchedules={yearlySchedules}
            />

            {/* CTA 배너 — 공통 CTABanner 재사용 */}
            <CTABanner variant="outline"
                title="더 궁금한 점이 있으신가요?"
                subtitle="일정에 대해 문의해 주시면 자세히 안내해 드립니다"
                phone={phone}
                primaryLabel="체험 수업 신청"
                primaryHref="/apply"
            />
        </PublicPageLayout>
    );
}
