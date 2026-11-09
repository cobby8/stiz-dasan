/**
 * 상담 신청 — /apply/consult (공개, 로그인 없이)
 * 2026-11-10 원장 승인(k1·m4): 학생 인적 사항·희망 수업·요청사항을 받으면 관리자가 확인 후 전화한다.
 * 챗봇 [ACTION:CONSULT] 버튼은 ?from=chatbot 을 붙여 연다 → 접수 경로가 «챗봇»으로 남는다.
 */
import { getAcademySettings } from "@/lib/queries";
import PublicPageLayout from "@/components/PublicPageLayout";
import ConsultForm from "@/components/consult/ConsultForm";
import { buildPublicMetadata } from "@/lib/publicMetadata";

export const revalidate = 300;

export const metadata = buildPublicMetadata({
    title: "상담 신청 | STIZ 농구교실 다산2호점",
    description: "스티즈 농구교실 다산2호점 상담 신청. 아이 학년과 희망 요일·시간을 남겨 주시면 확인 후 전화로 안내해 드립니다.",
    path: "/apply/consult",
});

export default async function ConsultApplyPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
    const [params, settings] = await Promise.all([searchParams, getAcademySettings()]);
    const source = params.from?.toLowerCase() === "chatbot" ? "CHATBOT" : "PUBLIC_WEB";
    const phone = (settings as { contactPhone?: string | null } | null)?.contactPhone || undefined;

    return (
        <PublicPageLayout>
            {/* 컴팩트 히어로 — 제목 1줄 + 핵심 정보 1줄(공용 배너 규칙 public-page-hero--compact) */}
            <section className="public-page-hero public-page-hero--compact px-4">
                <div className="mx-auto max-w-2xl">
                    <h1>상담 신청</h1>
                    <p className="break-keep">아이 정보와 희망 수업을 남겨 주시면 확인 후 전화로 안내해 드려요.</p>
                </div>
            </section>

            <section className="public-content-section px-4 py-6">
                <div className="mx-auto max-w-2xl">
                    <ConsultForm mode="public" source={source} contactPhone={phone} homeHref="/apply" />
                </div>
            </section>
        </PublicPageLayout>
    );
}
