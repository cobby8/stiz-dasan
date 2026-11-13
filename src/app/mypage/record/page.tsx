import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getChildRecord, listRecordChildren } from "@/lib/parent/childRecordQuery";
import ChildRecordClient from "./ChildRecordClient";

// 학부모 «아이 기록» (2026-11-14 원장 결정 w1·w2) — 다닌 기간·출석·청구·수강 반 이력·특강·유니폼·리포트를 한 장에.
// 하단 탭은 4개 그대로 두고 «홈» 소속 화면이다(MyPageBottomNav PARENT_TABS 홈 also).
// 진입: 홈 히어로 아래 한 줄 · 청구 탭 맨 위 «연도별 보기» · 수업 탭 반 카드 아래 «전체 기록».
// 아이·보호자마다 다른 돈·출결 기록이라 캐시하지 않는다.
export const dynamic = "force-dynamic";

export default async function ChildRecordPage({
  searchParams,
}: {
  // ?child=<studentId>(내 아이가 아니면 무시하고 첫째) · ?year=YYYY(청구 이력 연도)
  searchParams: Promise<{ child?: string; year?: string }>;
}) {
  const parent = await requireVerifiedParent().catch(() => null);
  // bounced=1 로 목적지를 지운다 — 여기로 되돌려보내면 거절 → 판별 → 거절이 무한 반복된다.
  if (!parent) redirect("/mypage/continue?bounced=1");

  const params = await searchParams;
  const children = await listRecordChildren(parent.appUserId).catch(() => []);
  if (children.length === 0) redirect("/mypage");

  // 주소의 아이 id 는 «내 아이 목록» 안에서만 고른다. getChildRecord 가 SQL 에서 한 번 더 확인한다(IDOR)
  const wanted = children.find((c) => c.id === params.child)?.id ?? children[0].id;
  let record = await getChildRecord(parent.appUserId, wanted).catch(() => null);
  if (!record && wanted !== children[0].id) record = await getChildRecord(parent.appUserId, children[0].id).catch(() => null);
  if (!record) {
    return (
      <p role="alert" className="academy-panel p-4 text-center text-sm text-[var(--color-academy-muted)]">
        기록을 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.
      </p>
    );
  }

  return <ChildRecordClient record={record} childList={children} initialYear={params.year ?? null} />;
}
