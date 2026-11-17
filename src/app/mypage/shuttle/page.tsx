import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getShuttleExceptionOptions } from "@/lib/shuttle/parent-shuttle-exception";
import { parseRequestPreset } from "@/lib/mypage/requestPreset";
import { getUsableAcademyPhone, getAcademyContact } from "@/lib/academyPhone";
import { regularChangeAvailable } from "@/lib/shuttle/regularChangeRequest";
import { getAccountViewAccess } from "@/lib/account-view-access";
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

  // 학원 번호(설정값) — 알림이 기사님께 못 갔을 때 «학원에 전화하기» 버튼용. 못 읽으면 null(글자만 보인다)
  // «계속 바꾸기» 입구는 신청 표가 있을 때만 보인다(마이그레이션 전에는 숨는다 — 못 읽어도 false)
  // 카카오 채널 주소(설정값) — 마감 뒤 «카카오 문의» 버튼용(같은 요청 안에서 설정은 한 번만 읽힌다)
  // 자녀 유무(hasOwnChildren) — 레이아웃이 같은 요청에서 이미 읽은 값(요청 단위 캐시, 새 DB 조회 없음).
  // initial.children 은 «다니는 반이 있는 자녀»라 0명이어도 연결된 자녀는 있을 수 있다 — 그래서 따로 본다
  const [initial, academyPhone, regularReady, contact, access] = await Promise.all([
    getShuttleExceptionOptions(parent.appUserId), getUsableAcademyPhone(), regularChangeAvailable(), getAcademyContact(), getAccountViewAccess(),
  ]);
  const preset = parseRequestPreset(searchParams ? await searchParams : null);
  const regularChangeHref = regularReady
    ? `/mypage/shuttle/regular${preset.studentId ? `?studentId=${encodeURIComponent(preset.studentId)}` : ""}`
    : null;
  return <ShuttleExceptionClient initial={initial} presetStudentId={preset.studentId} academyPhone={academyPhone} regularChangeHref={regularChangeHref} kakaoChannelUrl={contact.kakaoChannelUrl} noChildren={access.hasOwnChildren === false} />;
}
