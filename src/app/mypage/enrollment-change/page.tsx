import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getEnrollmentChangeOptions } from "@/lib/enrollment/parent-change-request";
import { getClassAddOptions } from "@/lib/enrollment/parent-class-add";
import { parseRequestPreset } from "@/lib/mypage/requestPreset";
import { getUsableAcademyPhone, getAcademyContact } from "@/lib/academyPhone";
import { academyTel } from "@/lib/academyPhoneRules";
import { getAccountViewAccess } from "@/lib/account-view-access";
import EnrollmentChangeClient from "./EnrollmentChangeClient";

export const dynamic = "force-dynamic";

export default async function EnrollmentChangePage({
  searchParams,
}: {
  // 수업 탭 반 카드가 ?studentId=&enrollmentId=&kind= 를 붙여 연다 — 그 반·그 종류를 미리 고른다(힌트일 뿐, 목록은 서버가 거른 내 자녀 것)
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parent = await requireVerifiedParent().catch(() => null);
  // bounced=1 로 목적지를 지운다. 여기로 되돌려보내면 거절 → 판별 → 거절이 무한 반복된다.
  // /mypage/continue 로 가야 설치된 학부모 앱이 제 영역을 벗어나지 않는다.
  if (!parent) redirect("/mypage/continue?bounced=1");

  // 반 추가 후보(학년 맞는 반·검토 중 신청)는 따로 읽는다 — 실패해도 빈 값이라 나머지 신청은 그대로 쓸 수 있다.
  // 학원 번호(설정값) — 하루 접수 상한에 걸렸을 때의 «학원에 전화하기» 버튼용. 못 읽으면 null(글자만 보인다)
  // 카카오 채널 주소(설정값) — 다니는 반이 없을 때의 «카카오 문의» 버튼용(같은 요청 안에서 설정은 한 번만 읽힌다)
  // 자녀 유무(hasOwnChildren) — 레이아웃이 같은 요청에서 이미 읽은 값(요청 단위 캐시, 새 DB 조회 없음).
  // initial.children 은 «다니는 반이 있는 자녀»라 0명이어도 연결된 자녀는 있을 수 있다 — 그래서 따로 본다
  const [initial, classAdd, academyPhone, contact, access] = await Promise.all([
    getEnrollmentChangeOptions(parent.appUserId),
    getClassAddOptions(parent.appUserId),
    getUsableAcademyPhone().catch(() => null),
    getAcademyContact(),
    getAccountViewAccess(),
  ]);
  const preset = parseRequestPreset(searchParams ? await searchParams : null);
  return <EnrollmentChangeClient initial={initial} classAdd={classAdd} preset={preset} academyTel={academyTel(academyPhone)} kakaoChannelUrl={contact.kakaoChannelUrl} noChildren={access.hasOwnChildren === false} />;
}
