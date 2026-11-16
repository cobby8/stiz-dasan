import { redirect } from "next/navigation";
import { requireOwnAccount } from "@/lib/account/own-account";
import { getAccountViewAccess } from "@/lib/account-view-access";
import { getAccountWithdrawalStatus } from "@/app/actions/parent-account";
import OwnAccountFrame from "@/components/account/OwnAccountFrame";
import WithdrawClient from "@/app/mypage/withdraw/WithdrawClient";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "회원 탈퇴 | 스티즈 농구교실",
  description: "스티즈 농구교실 본인 계정의 탈퇴를 요청합니다.",
};
export default async function AccountWithdrawalPage() {
  const account = await requireOwnAccount().catch(() =>
    redirect("/login?redirect=/account/withdraw"),
  );
  // hasOwnChildren — 같은 조회에서 이미 구한 값(새 DB 조회 없음). 자녀가 없으면 홈 문의 폼이 없어 «자녀 연결하기»로 보낸다
  const [initial, { views, hasOwnChildren }] = await Promise.all([
    getAccountWithdrawalStatus(),
    getAccountViewAccess(),
  ]);
  return (
    <OwnAccountFrame views={views}>
      <WithdrawClient
        initial={initial}
        parentName={account.appUserName}
        backHref="/account"
        noChildren={hasOwnChildren === false}
        childConnectHref="/account/children"
      />
    </OwnAccountFrame>
  );
}
