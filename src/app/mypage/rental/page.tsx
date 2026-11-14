import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import ParentEmbeddedPublic from "@/components/parent/ParentEmbeddedPublic";
import RentalGuide from "@/app/rental/RentalGuide";
import RentalClient from "@/app/rental/RentalClient";
import { PARENT_APPLY_HOME } from "@/lib/mypage/parentApplyMenu";

export const dynamic = "force-dynamic";
export const metadata = { title: "체육관 대관 | 스티즈 농구교실" };

// 학부모 앱 안의 체육관 대관 신청 (2026-11-14 원장 결정표 c9).
// 공개 /rental 은 설치 앱의 범위(/mypage) 밖이라 누르면 돌아올 길이 없다 → 같은 안내·같은 신청 부품을 앱 안에서 그린다.
// 신청 규칙·검증·저장은 공개 화면과 같은 부품·같은 서버 동작(중복 구현 없음).
// 로그인한 학부모라 신청자 이름·연락처가 미리 채워지고, 연결된 재원생이 있으면 «재원생 무료 대관» 칸이 바로 보인다
// (둘 다 RentalClient 가 서버 동작 getRentalMemberContext 로 묻는 기존 동작).

export default async function ParentRentalPage() {
    const parent = await requireVerifiedParent().catch(() => null);
    if (!parent) redirect("/mypage/continue?bounced=1");

    return (
        <ParentEmbeddedPublic backHref={PARENT_APPLY_HOME} backLabel="신청 메뉴로" title="체육관 대관">
            <div className="grid gap-5 p-3 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
                <RentalGuide />
                {/* 접수 뒤 «홈으로»는 학부모 홈으로(공개 홈페이지로 나가지 않는다) */}
                <RentalClient homeHref="/mypage" />
            </div>
        </ParentEmbeddedPublic>
    );
}
