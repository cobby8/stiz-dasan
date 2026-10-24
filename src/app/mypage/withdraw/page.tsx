import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getAccountWithdrawalStatus } from "@/app/actions/parent-account";
import WithdrawClient from "./WithdrawClient";

export const dynamic = "force-dynamic";

// 이 주소는 구글플레이 등록 양식의 «계정 삭제 요청 URL» 로도 쓴다.
// 그래서 앱 안에서만 열리는 화면이 아니라 독립된 페이지로 둔다.
export const metadata = {
  title: "회원 탈퇴 | 스티즈 농구교실",
  description: "스티즈 농구교실 학부모 계정을 삭제합니다.",
};

export default async function WithdrawPage() {
  const parent = await requireVerifiedParent().catch(() => null);
  // bounced=1 로 목적지를 지운다. 여기로 되돌려보내면 거절 → 판별 → 거절이 무한 반복된다.
  if (!parent) redirect("/mypage/continue?bounced=1");

  const status = await getAccountWithdrawalStatus();
  return <WithdrawClient initial={status} parentName={parent.appUserName} />;
}
