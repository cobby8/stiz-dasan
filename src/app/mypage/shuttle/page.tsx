import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getShuttleExceptionOptions } from "@/lib/shuttle/parent-shuttle-exception";
import { parseRequestPreset } from "@/lib/mypage/requestPreset";
import ShuttleExceptionClient from "./ShuttleExceptionClient";

export const dynamic = "force-dynamic";

export default async function ParentShuttlePage({
  searchParams,
}: {
  // 수업 탭 반 카드가 ?studentId= 를 붙여 연다 — 그 아이를 먼저 보인다(힌트일 뿐, 목록은 서버가 거른 내 자녀 것)
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parent = await requireVerifiedParent().catch(() => null);
  // bounced=1 로 목적지를 지운다. 여기로 되돌려보내면 거절 → 판별 → 거절이 무한 반복된다.
  if (!parent) redirect("/mypage/continue?bounced=1");

  const initial = await getShuttleExceptionOptions(parent.appUserId);
  const preset = parseRequestPreset(searchParams ? await searchParams : null);
  return <ShuttleExceptionClient initial={initial} presetStudentId={preset.studentId} />;
}
