import { getAcademySettings, getPublicFaqs } from "@/lib/queries";
import PublicPageLayout from "@/components/PublicPageLayout";
import CTABanner from "@/components/landing/CTABanner";
import ApplyPageClient from "./ApplyPageClient";
import { sanitizeHtml } from "@/lib/sanitize";
import { buildPublicMetadata } from "@/lib/publicMetadata";

export const revalidate = 60;
export const metadata = buildPublicMetadata({
    title: "체험/수강신청 | STIZ 농구교실 다산2호점",
    description: "스티즈 농구교실 다산2호점 체험 수업 신청 및 수강 신청 안내. 지금 바로 신청하세요.",
    path: "/apply",
});

type ApplyPageSettings = {
    contactPhone?: string | null;
    trialTitle?: string | null;
    trialContent?: string | null;
    enrollTitle?: string | null;
    enrollContent?: string | null;
};

function toSafeApplyContent(content: string | null | undefined) {
    if (!content) return null;
    if (/<[a-z][\s\S]*>/i.test(content)) return sanitizeHtml(content);
    return sanitizeHtml(content.replace(/\n/g, "<br>"));
}

export default async function ApplyPage() {
    // 설정과 FAQ를 동시에 조회 (성능 최적화)
    const [settings, faqData] = await Promise.all([
        getAcademySettings() as Promise<ApplyPageSettings>,
        getPublicFaqs(),
    ]);
    const phone = settings?.contactPhone || "010-0000-0000";

    return (
        <PublicPageLayout>
            {/* 페이지 히어로 — 그라데이션 배경 + 장식 도형 (about/page.tsx 패턴 동일) */}
            <section className="public-page-intro"><div className="public-container"><h1>체험·수강 신청</h1><p>처음이라면 체험수업부터, 등록을 결정하셨다면 수강 신청을 선택하세요.</p></div></section>

            {/* 수강 과정 4단계 안내 — ProcessSteps 재사용 */}


            {/* 체험수업/수강신청 카드 + FAQ — 클라이언트 컴포넌트 */}
            <ApplyPageClient
                trialTitle={settings?.trialTitle || "체험수업 안내"}
                trialContentHtml={toSafeApplyContent(settings?.trialContent)}
                enrollTitle={settings?.enrollTitle || "수강신청 안내"}
                enrollContentHtml={toSafeApplyContent(settings?.enrollContent)}
                faqData={faqData}
            />

            {/* CTA 배너 — 하단 행동 유도 (about 페이지와 동일 패턴) */}
            <CTABanner
                title="궁금한 점이 있으신가요?"
                subtitle="전화 한 통이면 친절하게 안내해 드립니다"
                phone={phone}
                primaryLabel="체험 수업 신청"
                primaryHref="/apply/trial"
            />
        </PublicPageLayout>
    );
}
