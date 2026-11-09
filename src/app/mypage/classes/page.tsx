import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getParentClassesOverview } from "@/lib/parent/classes-overview";
import { getParentRequestTimeline } from "@/lib/requests/parent-timeline";
import { getParentMonthViews } from "@/lib/mypage/parentMonthViews";
import ClassesClient from "./ClassesClient";

// 학부모 «수업» 탭 (2026-11-10 원장 결정 d5 — 홈·수업·청구·소식).
// 아이 칩 → 반 카드(상태·다음 수업·최근 출결·셔틀·신청 버튼) → 한 달 달력(일정 탭과 같은 부품) → 신청 내역 타임라인(최근 3개월).
// 2026-11-10: «달력 ▸» 이동 대신 이 화면에 달력을 붙였다(/mypage/history 주소는 그대로 남는다).
// 자녀 보안 조회가 있어 실시간.
export const dynamic = "force-dynamic";

export default async function ParentClassesPage({
  searchParams,
}: {
  // ?child=<studentId> 로 아이를 고른다(남의 학생 id 면 무시하고 첫 아이) · ?month=YYYY-MM 로 달력 달
  searchParams: Promise<{ child?: string; month?: string }>;
}) {
  const parent = await requireVerifiedParent().catch(() => null);
  // bounced=1 로 목적지를 지운다 — 여기로 되돌려보내면 거절 → 판별 → 거절이 무한 반복된다.
  if (!parent) redirect("/mypage/continue?bounced=1");

  // 타임라인 조회가 통째로 실패해도 반 카드는 열리게 빈 목록(표마다 실패는 안쪽에서 이미 따로 받는다)
  // 달력 조회가 실패해도 반 카드·타임라인은 열리게 null(달력 칸만 빠진다)
  const params = await searchParams;
  const [overview, timeline, calendar] = await Promise.all([
    getParentClassesOverview(parent.appUserId),
    getParentRequestTimeline(parent.appUserId).catch(() => []),
    getParentMonthViews(parent.appUserId, params.month).catch(() => null),
  ]);
  const { child } = params;
  const selected = overview.children.find((c) => c.id === child)?.id ?? overview.children[0]?.id ?? "";
  return <ClassesClient overview={overview} initialChildId={selected} timeline={timeline} calendar={calendar} />;
}
