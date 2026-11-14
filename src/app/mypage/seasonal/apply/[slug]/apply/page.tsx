import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getMyPageData } from "@/lib/queries";
import ParentEmbeddedPublic from "@/components/parent/ParentEmbeddedPublic";
import SeasonalApplyClient from "@/components/seasonal/SeasonalApplyClient";
import { PARENT_SEASONAL_APPLY_BASE } from "@/lib/mypage/parentApplyMenu";
import { seasonalApplyPrefill } from "@/lib/mypage/parentApplyPrefill";

export const dynamic = "force-dynamic";
export const metadata = { title: "방학특강 신청 | 스티즈 농구교실" };

// 학부모 앱 안의 방학특강 신청 — 신청서. 공개 /seasonal/[slug]/apply 와 같은 부품·같은 접수 API(2026-11-14 c9).
// 로그인한 학부모의 이름·연락처(아이가 한 명이면 아이 이름·생년월일도)를 미리 채운다 — 전부 고칠 수 있다.
// 미리 채우는 값은 서버가 확인한 로그인 사용자 것만(화면 값으로 남의 정보를 채울 수 없다).

export default async function ParentSeasonalApplyFormPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const parent = await requireVerifiedParent().catch(() => null);
    if (!parent) redirect("/mypage/continue?bounced=1");

    // 미리 채움은 편의 기능 — 조회가 실패해도 빈 신청서로 열린다
    const home = await getMyPageData(parent.appUserId).catch(() => null);

    return (
        <ParentEmbeddedPublic backHref={`${PARENT_SEASONAL_APPLY_BASE}/${encodeURIComponent(slug)}`} backLabel="특강 내용으로" title="방학특강 신청">
            <SeasonalApplyClient
                slug={slug}
                basePath={PARENT_SEASONAL_APPLY_BASE}
                homeHref="/mypage"
                prefill={seasonalApplyPrefill(home)}
            />
        </ParentEmbeddedPublic>
    );
}
