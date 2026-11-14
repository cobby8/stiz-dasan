import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import ParentEmbeddedPublic from "@/components/parent/ParentEmbeddedPublic";
import SeasonalDetailClient from "@/components/seasonal/SeasonalDetailClient";
import { PARENT_SEASONAL_APPLY_BASE } from "@/lib/mypage/parentApplyMenu";

export const dynamic = "force-dynamic";
export const metadata = { title: "방학특강 신청 | 스티즈 농구교실" };

// 학부모 앱 안의 방학특강 신청 — 특강 상세(수업·일정·수강료). 공개 /seasonal/[slug] 와 같은 부품(2026-11-14 c9).

export default async function ParentSeasonalApplyDetailPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const parent = await requireVerifiedParent().catch(() => null);
    if (!parent) redirect("/mypage/continue?bounced=1");

    return (
        <ParentEmbeddedPublic backHref={PARENT_SEASONAL_APPLY_BASE} backLabel="방학특강 목록으로" title="방학특강">
            <SeasonalDetailClient slug={slug} basePath={PARENT_SEASONAL_APPLY_BASE} />
        </ParentEmbeddedPublic>
    );
}
