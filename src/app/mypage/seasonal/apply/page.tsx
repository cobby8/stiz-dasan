import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import ParentEmbeddedPublic from "@/components/parent/ParentEmbeddedPublic";
import SeasonalListClient from "@/components/seasonal/SeasonalListClient";
import { PARENT_APPLY_HOME, PARENT_SEASONAL_APPLY_BASE } from "@/lib/mypage/parentApplyMenu";

export const dynamic = "force-dynamic";
export const metadata = { title: "방학특강 신청 | 스티즈 농구교실" };

// 학부모 앱 안의 방학특강 신청 — 목록 (2026-11-14 원장 결정표 c9).
// 공개 /seasonal 과 같은 부품을 그리고, 화면 사이 이동 주소만 앱 안(/mypage/seasonal/apply/…)으로 바꾼다.
// (이미 신청한 특강의 결석·보강은 /mypage/seasonal — 다른 화면이다)

export default async function ParentSeasonalApplyListPage() {
    const parent = await requireVerifiedParent().catch(() => null);
    if (!parent) redirect("/mypage/continue?bounced=1");

    return (
        <ParentEmbeddedPublic backHref={PARENT_APPLY_HOME} backLabel="신청 메뉴로" title="방학특강 신청">
            <div className="p-3">
                <SeasonalListClient basePath={PARENT_SEASONAL_APPLY_BASE} />
            </div>
        </ParentEmbeddedPublic>
    );
}
