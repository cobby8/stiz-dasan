import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getEnrollmentChangeOptions } from "@/lib/enrollment/parent-change-request";
import { getClassAddOptions } from "@/lib/enrollment/parent-class-add";
import { parseRequestPreset } from "@/lib/mypage/requestPreset";
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
  const [initial, classAdd] = await Promise.all([
    getEnrollmentChangeOptions(parent.appUserId),
    getClassAddOptions(parent.appUserId),
  ]);
  const preset = parseRequestPreset(searchParams ? await searchParams : null);
  return <EnrollmentChangeClient initial={initial} classAdd={classAdd} preset={preset} />;
}
