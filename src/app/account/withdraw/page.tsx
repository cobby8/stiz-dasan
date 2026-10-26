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
  const [initial, { views }] = await Promise.all([
    getAccountWithdrawalStatus(),
    getAccountViewAccess(),
  ]);
  return (
    <OwnAccountFrame views={views}>
      <WithdrawClient
        initial={initial}
        parentName={account.appUserName}
        backHref="/account"
      />
    </OwnAccountFrame>
  );
}
