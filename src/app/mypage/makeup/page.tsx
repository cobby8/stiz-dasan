import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getMakeupOverviewForParent } from "@/lib/makeup/parent-makeup";
import { parseRequestPreset } from "@/lib/mypage/requestPreset";
import { getAcademyContact } from "@/lib/academyPhone";
import MakeupClient from "./MakeupClient";

export const dynamic = "force-dynamic";

export default async function MakeupPage({
  searchParams,
}: {
  // 수업 탭 반 카드가 ?studentId= 를 붙여 연다 — 그 아이를 먼저 보인다(힌트일 뿐, 목록은 서버가 거른 내 자녀 것)
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parent = await requireVerifiedParent().catch(() => null);
  // regular-absence 와 동일 — 되돌려보내면 무한 반복이라 목적지를 지운다.
  if (!parent) redirect("/mypage/continue?bounced=1");

  // 학원 전화·카카오 채널(설정값) — 마감 뒤 «전화·문의» 버튼용. 못 읽어도 화면은 뜬다(버튼만 숨는다)
  const [overview, contact] = await Promise.all([
    getMakeupOverviewForParent(parent.appUserId),
    getAcademyContact(),
  ]);
  // Date/BigInt 직렬화 안전화(서버 → 클라이언트)
  const initial = JSON.parse(JSON.stringify(overview));
  const preset = parseRequestPreset(searchParams ? await searchParams : null);
  return <MakeupClient initial={initial} presetStudentId={preset.studentId} contact={contact} />;
}
