import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getRegularChangeOptions } from "@/lib/shuttle/regularChangeRequest";
import { parseRequestPreset } from "@/lib/mypage/requestPreset";
import { getUsableAcademyPhone } from "@/lib/academyPhone";
import { academyTel } from "@/lib/academyPhoneRules";
import RegularChangeClient from "./RegularChangeClient";

export const dynamic = "force-dynamic";

// 셔틀 타는 곳·내리는 곳을 «앞으로 계속» 바꾸는 신청(2026-11-14 결정표 c5).
// 하루만 바꾸는 «셔틀 변경»(/mypage/shuttle)의 머리 줄에서 들어온다. 원장이 승인해야 명단에 반영된다.
export default async function ParentShuttleRegularPage({
  searchParams,
}: {
  // ?studentId= 는 힌트일 뿐 — 목록은 서버가 거른 내 자녀 것만 온다
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parent = await requireVerifiedParent().catch(() => null);
  // bounced=1 로 목적지를 지운다. 여기로 되돌려보내면 거절 → 판별 → 거절이 무한 반복된다.
  if (!parent) redirect("/mypage/continue?bounced=1");

  // 학원 번호(설정값) — 하루 접수 상한에 걸렸을 때의 «학원에 전화하기» 버튼용. 못 읽으면 null(글자만 보인다)
  const [initial, academyPhone] = await Promise.all([
    getRegularChangeOptions(parent.appUserId),
    getUsableAcademyPhone().catch(() => null),
  ]);
  // 신청 표가 아직 없으면(마이그레이션 전) 이 화면은 쓸 수 없다 — 하루 변경 화면으로 돌려보낸다.
  if (!initial.available) redirect("/mypage/shuttle");
  const preset = parseRequestPreset(searchParams ? await searchParams : null);
  return <RegularChangeClient initial={initial} presetStudentId={preset.studentId} academyTel={academyTel(academyPhone)} />;
}
