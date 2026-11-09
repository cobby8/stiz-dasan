import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getParentClassesOverview } from "@/lib/parent/classes-overview";
import ClassesClient from "./ClassesClient";

// 학부모 «수업» 탭 (2026-11-10 원장 결정 d5 — 홈·수업·청구·소식).
// 아이 칩 → 반 카드(상태·다음 수업·최근 출결·셔틀·신청 버튼). 달력은 «달력 ▸»로 /mypage/history(주소 유지).
// 자녀 보안 조회가 있어 실시간.
export const dynamic = "force-dynamic";

export default async function ParentClassesPage({
  searchParams,
}: {
  // ?child=<studentId> 로 아이를 고른다(남의 학생 id 면 무시하고 첫 아이)
  searchParams: Promise<{ child?: string }>;
}) {
  const parent = await requireVerifiedParent().catch(() => null);
  // bounced=1 로 목적지를 지운다 — 여기로 되돌려보내면 거절 → 판별 → 거절이 무한 반복된다.
  if (!parent) redirect("/mypage/continue?bounced=1");

  const [{ child }, overview] = await Promise.all([searchParams, getParentClassesOverview(parent.appUserId)]);
  const selected = overview.children.find((c) => c.id === child)?.id ?? overview.children[0]?.id ?? "";
  return <ClassesClient overview={overview} initialChildId={selected} />;
}
