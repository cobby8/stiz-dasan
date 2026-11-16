import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getParentSeasonalContext } from "@/lib/seasonal/parent-makeup";
import { getAcademyContact } from "@/lib/academyPhone";
import SeasonalMakeupClient from "./SeasonalMakeupClient";

export const dynamic = "force-dynamic";

export default async function ParentSeasonalPage() {
  const parent = await requireVerifiedParent().catch(() => null);
  // bounced=1 로 목적지를 지운다. 여기로 되돌려보내면 거절 → 판별 → 거절이 무한 반복된다.
  // /mypage/continue 로 가야 설치된 학부모 앱이 제 영역을 벗어나지 않는다.
  if (!parent) redirect("/mypage/continue?bounced=1");
  // 학원 전화·카카오 채널(설정값) — «전화·문의» 버튼용. 못 읽어도 화면은 뜬다(버튼만 숨는다)
  const [ctx, contact] = await Promise.all([getParentSeasonalContext(parent.appUserId), getAcademyContact()]);
  const initial = JSON.parse(JSON.stringify(ctx));
  return <SeasonalMakeupClient initial={initial} contact={contact} />;
}
