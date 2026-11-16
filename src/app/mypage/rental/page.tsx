import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import ParentEmbeddedPublic from "@/components/parent/ParentEmbeddedPublic";
import RentalGuide from "@/app/rental/RentalGuide";
import RentalClient from "@/app/rental/RentalClient";
import { PARENT_APPLY_HOME } from "@/lib/mypage/parentApplyMenu";
import { getRentalMemberContext } from "@/app/actions/rental";
import MemberRentalGuide from "./MemberRentalGuide";

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

    // 2026-11-16 원장 지시: 재원생 가족에게는 외부 손님 요금표가 아니라 «우리 규칙»(2시간 무료·보증금 없음)으로 보이고 바로 신청.
    // 연결된 재원생이 없으면(퇴원·휴원 아이만) 한 줄 안내와 함께 일반 대관 화면을 그대로 보인다(원장 결정).
    // 무료 여부는 신청 때 서버가 계정 연결·재원을 다시 확인한다 — 여기 값은 화면을 고르는 데만 쓴다.
    const member = await getRentalMemberContext();
    const isMember = member.signedIn && member.students.length > 0;

    return (
        <ParentEmbeddedPublic backHref={PARENT_APPLY_HOME} backLabel="신청 메뉴로" title={isMember ? "재원생 무료 대관" : "체육관 대관"}>
            {/* 로그인 학부모 화면이라 signedIn=false 는 «조회 실패»다 — 그때는 «아이가 없다»고 잘못 말하지 않는다 */}
            {!isMember && member.signedIn && (
                <p className="mx-3 mt-3 rounded-[var(--color-public-radius)] bg-[var(--color-public-tint)] px-3 py-2 text-sm break-keep text-[var(--color-public-ink)]">
                    지금 수강 중인 아이가 없어 일반 대관 요금으로 신청돼요.
                </p>
            )}
            <div className="grid gap-5 p-3 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
                {isMember ? <MemberRentalGuide studentNames={member.students.map((s) => s.name)} /> : <RentalGuide />}
                {/* 접수 뒤 «홈으로»는 학부모 홈으로(공개 홈페이지로 나가지 않는다) */}
                <RentalClient homeHref="/mypage" memberMode={isMember} initialMember={member} />
            </div>
        </ParentEmbeddedPublic>
    );
}
