import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getAccountWithdrawalStatus } from "@/app/actions/parent-account";
import { getAcademyContact } from "@/lib/academyPhone";
import { getAccountViewAccess } from "@/lib/account-view-access";
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

  // 학원 전화·카카오 채널(설정값) — 맨 아래 «전화·문의» 버튼용. 못 읽어도 화면은 뜬다
  // 자녀 유무 — 레이아웃이 같은 요청에서 이미 읽은 값(요청 단위 캐시, 새 DB 조회 없음). 0명이면 문의 링크를 자녀 연결로
  const [status, contact, access] = await Promise.all([getAccountWithdrawalStatus(), getAcademyContact(), getAccountViewAccess()]);
  return <WithdrawClient initial={status} parentName={parent.appUserName} contact={contact} noChildren={access.hasOwnChildren === false} />;
}
